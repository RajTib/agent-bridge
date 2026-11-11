import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import {
  Audit,
  DASHBOARD_PASSWORD_FILE,
  DecisionService,
  EventBus,
  HOOK_TOKEN_FILE,
  SessionService,
  Store,
  loadOrCreateSecret,
  openDatabase,
  type AppConfig,
} from '@agentbridge/core';
import { CallManager, MockTelephonyProvider, createProvider, type TelephonyProvider } from '@agentbridge/telephony';
import { ALL_DISCORD_KINDS, DiscordNotifier, type DiscordKind } from '@agentbridge/discord';
import type { AuthDeps } from './auth.js';
import { registerRoutes } from './routes.js';

export interface Services {
  config: AppConfig;
  store: Store;
  bus: EventBus;
  audit: Audit;
  sessions: SessionService;
  decisions: DecisionService;
  calls: CallManager;
  provider: TelephonyProvider | null;
  discord: DiscordNotifier | null;
  authDeps: AuthDeps;
  webhookBaseUrl: string | null;
  startedAt: string;
  secrets: { hookTokenPath: string; hookTokenSource: string; passwordPath: string; passwordSource: string };
}

export interface BuildOptions {
  config: AppConfig;
  /** Override the telephony provider (tests). */
  provider?: TelephonyProvider | null;
  /** Override the Discord fetch (tests). */
  discordFetch?: typeof fetch;
  logger?: boolean;
  now?: () => Date;
  /** Use an in-memory database (tests). */
  inMemoryDb?: boolean;
}

function defaultDashboardDir(): string {
  // apps/server/dist/app.js -> apps/dashboard/dist
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dashboard', 'dist');
}

export async function buildApp(o: BuildOptions): Promise<{ app: FastifyInstance; services: Services }> {
  const { config } = o;
  const now = o.now ?? (() => new Date());

  const store = new Store(openDatabase(o.inMemoryDb ? ':memory:' : config.dbPath));
  const bus = new EventBus();
  const audit = new Audit(store, bus, now);
  const sessions = new SessionService(store, bus, audit, now);
  const decisions = new DecisionService({
    store,
    bus,
    audit,
    sessions,
    timeoutSeconds: config.approvalTimeoutSeconds,
    heartbeatGraceSeconds: config.heartbeatGraceSeconds,
    now,
  });

  const provider = o.provider !== undefined ? o.provider : createProvider(config);
  const localBase = `http://127.0.0.1:${config.port}`;
  const webhookBaseUrl = config.publicUrl ?? (provider && !provider.requiresPublicUrl ? localBase : null);
  const calls = new CallManager({
    provider,
    store,
    decisions,
    bus,
    audit,
    telephony: config.telephony,
    webhookBaseUrl,
    now,
  });
  if (provider instanceof MockTelephonyProvider) {
    provider.onChange((view) =>
      bus.emit('mock-call', { ...view, decisionId: store.getCall(view.callId)?.decisionId ?? '' }),
    );
  }

  let discord: DiscordNotifier | null = null;
  if (config.discord.webhookUrl) {
    const kinds = config.discord.events
      ? (config.discord.events.filter((k) => (ALL_DISCORD_KINDS as string[]).includes(k)) as DiscordKind[])
      : null;
    discord = new DiscordNotifier({ webhookUrl: config.discord.webhookUrl, kinds, fetchImpl: o.discordFetch });
    bus.on('audit', (e) => discord!.handle(e));
  }

  const hookToken = loadOrCreateSecret(config.dataDir, HOOK_TOKEN_FILE, config.hookToken, {
    mirrorExplicitToFile: true,
  });
  const password = loadOrCreateSecret(config.dataDir, DASHBOARD_PASSWORD_FILE, config.dashboardPassword);
  const authDeps: AuthDeps = { store, hookToken: hookToken.value, dashboardPassword: password.value, now };

  const services: Services = {
    config,
    store,
    bus,
    audit,
    sessions,
    decisions,
    calls,
    provider,
    discord,
    authDeps,
    webhookBaseUrl,
    startedAt: now().toISOString(),
    secrets: {
      hookTokenPath: hookToken.path,
      hookTokenSource: hookToken.source,
      passwordPath: password.path,
      passwordSource: password.source,
    },
  };

  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    logger:
      o.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-twilio-signature"]',
                'req.headers["x-mock-signature"]',
                'res.headers["set-cookie"]',
              ],
              censor: '[redacted]',
            },
          },
  });

  await app.register(cookie);
  await app.register(formbody, { bodyLimit: 64 * 1024 });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    // Long-polling hooks and SSE are authenticated and cheap; never lock them out.
    allowList: (req) => req.url.startsWith('/api/hooks/') || req.url === '/api/stream',
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (!req.url.startsWith('/telephony/')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });

  await registerRoutes(app, services);

  const dashboardDir = config.dashboardDir ? resolve(config.dashboardDir) : defaultDashboardDir();
  if (existsSync(join(dashboardDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: dashboardDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/telephony/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<!doctype html><title>AgentBridge</title><body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;padding:2rem">' +
            '<h1>AgentBridge server is running</h1><p>The dashboard has not been built yet. Run <code>npm run build</code>.</p></body>',
        ),
    );
  }

  app.addHook('onClose', async () => {
    calls.stop();
    decisions.stop();
    store.db.close();
  });

  return { app, services };
}

export function startServices(services: Services): void {
  services.decisions.start();
  services.calls.start();
  services.audit.record({
    type: 'server.started',
    message: `AgentBridge ${services.provider ? `started with the ${services.provider.name}${services.provider.isRealCall ? '' : ' (simulated)'} telephony provider` : 'started with phone calls disabled'}`,
  });
}
