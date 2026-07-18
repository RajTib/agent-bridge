import { createServer, type IncomingMessage } from 'node:http';
import type { ChannelAdapter, NormalizedEvent } from '@agentbridge/contracts';
import { createDiscordChannelAdapter } from '@agentbridge/adapter-discord';
import { ApprovalRelay } from './relay';
import { AuditLog } from './audit-log';
import { loadOrCreateDaemonSecret } from './secret';
import { loadConfig, expandHome } from './config';
import { resolveChannel } from './router';

export const DEFAULT_PORT = 8787;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export interface DaemonOptions {
  configPath: string;
  port?: number;
}

/**
 * Starts the relay daemon: loads config, wires up configured channels,
 * and exposes a local-only HTTP API for `agentbridge hook` to talk to.
 * Runs until the process is killed (Ctrl+C) -- there's no background
 * service/systemd integration in the MVP, this runs in the foreground.
 */
export async function startDaemon(options: DaemonOptions): Promise<void> {
  const config = loadConfig(options.configPath);
  const secret = loadOrCreateDaemonSecret();
  const port = options.port ?? (Number(process.env.AGENTBRIDGE_PORT) || DEFAULT_PORT);

  const auditLog = new AuditLog(expandHome(config.audit_log.path));
  const relay = new ApprovalRelay({
    secret,
    timeoutMs: config.timeout.seconds * 1000,
    auditLog,
  });

  const channels: Record<string, ChannelAdapter> = {};

  if (config.channels.discord) {
    const tokenEnv = config.channels.discord.bot_token_env ?? 'DISCORD_BOT_TOKEN';
    const channelIdEnv = config.channels.discord.channel_id_env ?? 'DISCORD_CHANNEL_ID';
    const token = process.env[tokenEnv];
    const channelId = process.env[channelIdEnv];

    if (token && channelId) {
      const discord = createDiscordChannelAdapter({ token, defaultChannelId: channelId });
      discord.onDecision(async (approvalId, decision, decidedBy, reason) => {
        if (decision === 'approved' || decision === 'denied') {
          relay.decide(approvalId, decision, decidedBy, 'discord', reason);
        }
        // 'timed_out' never arrives from a channel adapter -- only the
        // relay's own timer produces that outcome.
      });
      channels.discord = discord;
    } else {
      console.warn(
        `Discord is configured for routing but ${tokenEnv}/${channelIdEnv} aren't set -- Discord approvals will fail until they are.`,
      );
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers['x-agentbridge-secret'] !== secret) {
        res.writeHead(401).end('unauthorized');
        return;
      }

      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200).end('ok');
        return;
      }

      if (req.method === 'POST' && req.url === '/events') {
        try {
          const event = JSON.parse(await readBody(req)) as NormalizedEvent;

          if (event.eventType !== 'permission_required') {
            // Notification/run_completed/run_failed: audit only for now --
            // sending these to a channel needs a plain notify() method our
            // ChannelAdapter interface doesn't have yet (see docs/writing-an-adapter.md).
            auditLog.record({
              timestamp: new Date().toISOString(),
              agent: event.agent,
              sessionId: event.sessionId,
              eventType: event.eventType,
              summary: event.summary,
              riskHint: event.riskHint,
            });
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ logged: true }));
            return;
          }

          const channelName = resolveChannel(config.routing, event.agent, event.eventType);
          const channel = channelName ? channels[channelName] : undefined;

          if (!channel) {
            console.warn(
              `No usable channel for ${event.agent}/${event.eventType} -- failing safe to the agent's normal prompt.`,
            );
            res.writeHead(200, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                approvalId: 'unrouted',
                decision: 'timed_out',
                decidedAt: new Date().toISOString(),
              }),
            );
            return;
          }

          const { approval, outcome } = relay.create(event);
          await channel.send(approval);
          const result = await outcome;

          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
        } catch (err) {
          console.error('agentbridge daemon: error handling /events', err);
          res.writeHead(500).end('internal error');
        }
        return;
      }

      res.writeHead(404).end('not found');
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });

  console.log(`AgentBridge daemon listening on http://127.0.0.1:${port}`);
  console.log(`Audit log: ${expandHome(config.audit_log.path)}`);
  console.log(`Channels wired: ${Object.keys(channels).join(', ') || '(none)'}`);
}
