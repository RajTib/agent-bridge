import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

export interface RoutingRule {
  /** Agent name, or "*" to match any agent. */
  agent: string;
  /** NormalizedEvent eventType, or "*" to match any event type. */
  event_type: string;
  channel: string;
}

export interface ChannelConfig {
  bot_token_env?: string;
  channel_id_env?: string;
  [key: string]: string | undefined;
}

export interface AgentBridgeConfig {
  routing: RoutingRule[];
  timeout: { seconds: number; fallback: string };
  audit_log: { path: string };
  channels: Record<string, ChannelConfig>;
}

// Matches config/agentbridge.example.yml exactly, so the daemon works out
// of the box for the single-agent/single-channel MVP case even if the user
// hasn't copied the example file to a real config yet.
const DEFAULT_CONFIG: AgentBridgeConfig = {
  routing: [{ agent: '*', event_type: 'permission_required', channel: 'discord' }],
  timeout: { seconds: 300, fallback: 'terminal_prompt' },
  audit_log: { path: '~/.agentbridge/audit.log.jsonl' },
  channels: {
    discord: { bot_token_env: 'DISCORD_BOT_TOKEN', channel_id_env: 'DISCORD_CHANNEL_ID' },
  },
};

export function loadConfig(path: string): AgentBridgeConfig {
  if (!existsSync(path)) {
    return DEFAULT_CONFIG;
  }

  const raw = (parse(readFileSync(path, 'utf-8')) ?? {}) as Partial<AgentBridgeConfig>;
  return {
    routing: raw.routing ?? DEFAULT_CONFIG.routing,
    timeout: { ...DEFAULT_CONFIG.timeout, ...raw.timeout },
    audit_log: { ...DEFAULT_CONFIG.audit_log, ...raw.audit_log },
    channels: raw.channels ?? DEFAULT_CONFIG.channels,
  };
}

export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return path.replace('~', process.env.HOME ?? process.env.USERPROFILE ?? '.');
  }
  return path;
}
