import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  Decision,
  DecisionStatus,
  HookDecisionResponse,
  LiveMessage,
  Overview,
} from '@agentbridge/shared';
import { publicConfigSummary, redactSecrets } from '@agentbridge/core';
import { MockTelephonyProvider, type SignedWebhook } from '@agentbridge/telephony';
import type { Services } from './app.js';
import {
  checkPassword,
  createDashboardSession,
  destroyDashboardSession,
  isDashboardAuthenticated,
  requireDashboard,
  requireHookToken,
} from './auth.js';

export const VERSION = '0.2.0';

const STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled'] as const;

const PermissionRequestBody = z.object({
  sessionId: z.string().min(1).max(200),
  cwd: z.string().max(4096).nullable().optional(),
  toolName: z.string().min(1).max(200),
  toolInput: z.record(z.string(), z.unknown()),
  permissionMode: z.string().max(100).nullable().optional(),
});

const HookEventBody = z.object({
  event: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
});

const IdParam = z.object({ id: z.string().regex(/^dec_[A-Za-z0-9_-]{22}$/) });
const NoteBody = z.object({ note: z.string().max(500).optional() }).optional();

function hookResponse(d: Decision, s: Services, duplicate?: boolean): HookDecisionResponse {
  return {
    decisionId: d.id,
    status: d.status,
    expiresAt: d.expiresAt,
    duplicate,
    resolutionNote: d.resolutionNote,
    resolutionChannel: d.resolutionChannel,
    timeoutBehavior: s.config.timeoutBehavior,
  };
}

function str(v: unknown, max = 500): string | null {
  return typeof v === 'string' && v.length ? v.slice(0, max) : null;
}

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({ error: 'invalid request', issues: err.issues.map((i) => i.path.join('.') + ': ' + i.message) });
}

export async function registerRoutes(app: FastifyInstance, s: Services): Promise<void> {
  const deps = s.authDeps;
  const hookAuth = requireHookToken(deps);
  const dashAuth = requireDashboard(deps);

  // ---- public ---------------------------------------------------------

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  // ---- Claude Code hook API (bearer token) -----------------------------

  app.register(async (hooks) => {
    hooks.addHook('onRequest', hookAuth);

    hooks.get('/api/hooks/ping', async () => ({ ok: true }));

    hooks.post('/api/hooks/permission-request', { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
      const parsed = PermissionRequestBody.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const b = parsed.data;
      const { decision, duplicate } = s.decisions.create({
        sessionId: b.sessionId,
        agent: 'claude-code',
        cwd: b.cwd ?? null,
        toolName: b.toolName,
        toolInput: b.toolInput,
      });
      return reply.code(duplicate ? 200 : 201).send(hookResponse(decision, s, duplicate));
    });

    hooks.get('/api/hooks/decisions/:id/wait', async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'unknown decision' });
      const q = req.query as { timeoutMs?: string };
      const timeoutMs = Math.min(Math.max(Number(q.timeoutMs) || 0, 0), 25_000);
      const d = await s.decisions.wait(p.data.id, timeoutMs);
      if (!d) return reply.code(404).send({ error: 'unknown decision' });
      return hookResponse(d, s);
    });

    hooks.post('/api/hooks/event', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
      const parsed = HookEventBody.safeParse(req.body);
      if (!parsed.success) return badRequest(reply, parsed.error);
      const { event, payload } = parsed.data;
      const sessionId = str(payload.session_id, 200);
      if (!sessionId) return reply.code(400).send({ error: 'session_id required' });
      const touch = { sessionId, agent: 'claude-code', cwd: str(payload.cwd, 4096), model: str(payload.model, 100) };

      switch (event) {
        case 'SessionStart':
          s.sessions.start(touch, str(payload.source, 50));
          break;
        case 'SessionEnd': {
          s.sessions.touch(touch);
          s.sessions.end(sessionId, str(payload.reason, 100));
          s.decisions.cancelPendingForSession(sessionId, 'Claude Code session ended.');
          break;
        }
        case 'Notification': {
          s.sessions.touch(touch);
          const type = str(payload.notification_type, 100);
          s.audit.record({
            type: 'agent.notification',
            sessionId,
            message: redactSecrets(str(payload.message, 500) ?? 'Claude Code notification'),
            data: { notificationType: type, title: str(payload.title, 200) },
          });
          break;
        }
        case 'Stop': {
          const session = s.sessions.touch(touch);
          const last = str(payload.last_assistant_message, 400);
          s.audit.record({
            type: 'task.completed',
            sessionId,
            message: `Claude finished responding in ${session.projectName}${last ? `: ${redactSecrets(last.replace(/\s+/g, ' '))}` : ''}`,
          });
          break;
        }
        case 'StopFailure': {
          const session = s.sessions.touch(touch);
          s.audit.record({
            type: 'task.failed',
            level: 'error',
            sessionId,
            message: `Claude stopped with an error in ${session.projectName}: ${str(payload.error, 100) ?? 'unknown'}${
              str(payload.error_details, 300) ? ` (${str(payload.error_details, 300)})` : ''
            }`,
          });
          break;
        }
        default:
          s.sessions.touch(touch);
      }
      return reply.code(204).send();
    });
  });

  // ---- dashboard auth -------------------------------------------------

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { password?: unknown };
      if (!checkPassword(deps, body.password)) {
        s.audit.record({ type: 'auth.login_failed', level: 'warn', message: `Failed dashboard login from ${req.ip}` });
        return reply.code(401).send({ error: 'incorrect password' });
      }
      createDashboardSession(deps, req, reply);
      s.audit.record({ type: 'auth.login', message: `Dashboard login from ${req.ip}` });
      return { ok: true };
    },
  );

  app.get('/api/auth/me', async (req, reply) => {
    if (!isDashboardAuthenticated(deps, req)) return reply.code(401).send({ authenticated: false });
    return { authenticated: true };
  });

  // ---- dashboard API (session cookie + CSRF) ----------------------------

  app.register(async (dash) => {
    dash.addHook('onRequest', dashAuth);

    dash.post('/api/auth/logout', async (req, reply) => {
      destroyDashboardSession(deps, req, reply);
      s.audit.record({ type: 'auth.logout', message: 'Dashboard logout' });
      return reply.code(204).send();
    });

    dash.get('/api/overview', async (): Promise<Overview> => {
      const counts = s.store.decisionCounts();
      return {
        serverStartedAt: s.startedAt,
        version: VERSION,
        pendingCount: counts.pending,
        activeSessions: s.store.activeSessionCount(),
        decisionCounts: counts,
        callStats: s.store.callStats(),
        provider: s.calls.status(),
        discordEnabled: Boolean(s.discord),
        config: publicConfigSummary(s.config),
      };
    });

    dash.get('/api/decisions', async (req) => {
      const q = req.query as { status?: string; limit?: string };
      const status = (STATUSES as readonly string[]).includes(q.status ?? '') ? (q.status as DecisionStatus) : undefined;
      return { decisions: s.decisions.list({ status, limit: Number(q.limit) || 100 }) };
    });

    dash.get('/api/decisions/:id', async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      const d = p.success ? s.decisions.get(p.data.id) : null;
      if (!d) return reply.code(404).send({ error: 'not found' });
      return {
        decision: d,
        calls: s.store.listCalls({ decisionId: d.id }),
        events: s.store.listEvents({ decisionId: d.id, limit: 200 }),
      };
    });

    for (const action of ['approve', 'reject'] as const) {
      dash.post(`/api/decisions/:id/${action}`, async (req, reply) => {
        const p = IdParam.safeParse(req.params);
        if (!p.success) return reply.code(404).send({ error: 'not found' });
        const body = NoteBody.safeParse(req.body ?? {});
        const res = s.decisions.resolve(p.data.id, action === 'approve' ? 'approved' : 'rejected', {
          channel: 'dashboard',
          by: `dashboard (${req.ip})`,
          note: body.success ? (body.data?.note ?? null) : null,
        });
        if (!res.ok) {
          const msg = {
            not_found: 'Decision not found.',
            already_resolved: `Already ${res.decision?.status ?? 'resolved'}.`,
            expired: 'This request expired and can no longer be approved.',
          }[res.reason];
          return reply.code(res.reason === 'not_found' ? 404 : 409).send({ error: msg, reason: res.reason });
        }
        return { decision: res.decision };
      });
    }

    dash.post('/api/decisions/:id/call', async (req, reply) => {
      const p = IdParam.safeParse(req.params);
      if (!p.success) return reply.code(404).send({ error: 'not found' });
      const r = s.calls.requestCall(p.data.id);
      if (!r.ok) return reply.code(409).send({ error: r.reason });
      return { ok: true };
    });

    dash.get('/api/sessions', async () => ({ sessions: s.sessions.list(100) }));

    dash.get('/api/calls', async (req) => {
      const q = req.query as { limit?: string };
      return { calls: s.store.listCalls({ limit: Number(q.limit) || 50 }) };
    });

    dash.get('/api/events', async (req) => {
      const q = req.query as { limit?: string; beforeId?: string };
      return { events: s.store.listEvents({ limit: Number(q.limit) || 100, beforeId: Number(q.beforeId) || undefined }) };
    });

    dash.get('/api/stream', (req, reply) => {
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      const send = (m: LiveMessage) => res.write(`data: ${JSON.stringify(m)}\n\n`);
      const subs = [
        s.bus.on('decision.updated', (decision) => send({ kind: 'decision', decision })),
        s.bus.on('session', (session) => send({ kind: 'session', session })),
        s.bus.on('call', (call) => send({ kind: 'call', call })),
        s.bus.on('audit', (event) => send({ kind: 'event', event })),
        s.bus.on('mock-call', (mock) => send({ kind: 'mock-call', mock })),
      ];
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.raw.on('close', () => {
        clearInterval(ping);
        for (const u of subs) u();
      });
    });

    // ---- simulated handset (mock provider only) -----------------------

    const mock = s.provider instanceof MockTelephonyProvider ? s.provider : null;

    dash.get('/api/mock-phone', async (_req, reply) => {
      if (!mock) return reply.code(404).send({ error: 'mock provider not active' });
      return {
        calls: mock.views().map((v) => ({ ...v, decisionId: s.store.getCall(v.callId)?.decisionId ?? '' })),
      };
    });

    const deliver = async (w: SignedWebhook | null, providerCallId: string) => {
      if (!w || !mock) return false;
      const u = new URL(w.url);
      const res = await app.inject({
        method: 'POST',
        url: `${u.pathname}${u.search}`,
        headers: { ...w.headers, 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams(w.params).toString(),
      });
      if (res.statusCode === 200) mock.applyResponse(providerCallId, res.body);
      return res.statusCode < 300;
    };

    dash.post('/api/mock-phone/:callId/:action', async (req, reply) => {
      if (!mock) return reply.code(404).send({ error: 'mock provider not active' });
      const { callId, action } = req.params as { callId: string; action: string };
      const sim = mock.findByCallId(callId);
      if (!sim) return reply.code(404).send({ error: 'unknown simulated call' });
      const sid = sim.providerCallId;
      let ok: boolean;
      switch (action) {
        case 'answer':
          ok = await deliver(mock.answer(sid), sid);
          break;
        case 'press': {
          const digit = String((req.body as { digit?: unknown } | null)?.digit ?? '');
          if (!/^[0-9*#]$/.test(digit)) return reply.code(400).send({ error: 'digit must be 0-9, * or #' });
          ok = await deliver(mock.press(sid, digit), sid);
          break;
        }
        case 'silence':
          ok = await deliver(mock.silence(sid), sid);
          break;
        case 'hangup':
          ok = await deliver(mock.status(sid, 'completed'), sid);
          break;
        default:
          return reply.code(404).send({ error: 'unknown action' });
      }
      const view = mock.views().find((v) => v.callId === callId)!;
      return reply.code(ok ? 200 : 409).send({
        mock: { ...view, decisionId: s.store.getCall(callId)?.decisionId ?? '' },
        ...(ok ? {} : { error: 'action not possible in the current call state' }),
      });
    });
  });

  // ---- telephony provider webhooks (signature-verified) -----------------

  app.post(
    '/telephony/:provider/:callId/:kind',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } }, bodyLimit: 64 * 1024 },
    async (req, reply) => {
      const { provider, callId, kind } = req.params as { provider: string; callId: string; kind: string };
      if (!s.webhookBaseUrl) return reply.code(503).send('webhooks not configured');
      const result = await s.calls.handleWebhook(
        provider,
        callId,
        kind,
        {
          url: `${s.webhookBaseUrl}${req.url}`,
          headers: req.headers,
          params: (req.body ?? {}) as Record<string, string>,
        },
        req.query as Record<string, string | undefined>,
      );
      reply.code(result.status);
      if (result.contentType) reply.type(result.contentType);
      return reply.send(result.body ?? '');
    },
  );
}
