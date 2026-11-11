import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER } from '@agentbridge/shared';
import { newSecret, safeEqual, sha256, type Store } from '@agentbridge/core';
import { HOOK_AUTH_WINDOW_MS, hookResponseProof, verifyHookRequest } from '@agentbridge/claude-code';

export const SESSION_COOKIE = 'ab_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthDeps {
  store: Store;
  hookToken: string;
  dashboardPassword: string;
  now: () => Date;
}

const header = (req: FastifyRequest, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Pure signature check (no side effects); also used to exempt valid hook calls from rate limiting. */
export function hasValidHookSignature(deps: AuthDeps, req: FastifyRequest): boolean {
  return verifyHookRequest(
    deps.hookToken,
    {
      method: req.method,
      path: req.url,
      ts: header(req, 'x-agentbridge-ts'),
      nonce: header(req, 'x-agentbridge-nonce'),
      signature: header(req, 'x-agentbridge-signature'),
    },
    deps.now().getTime(),
  );
}

const AUTHENTICATED = Symbol('agentbridge.hookAuthenticated');

/**
 * Hook client authentication. The token is never transmitted: each request is
 * HMAC-signed (method, path, timestamp, nonce), nonces are single-use within
 * the validity window, and every response carries a proof the hook verifies,
 * so neither side can be impersonated by a process squatting on the port.
 */
export function requireHookToken(deps: AuthDeps, onFailure: (req: FastifyRequest) => void) {
  const seen = new Map<string, number>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const now = deps.now().getTime();
    for (const [n, exp] of seen) if (exp < now) seen.delete(n);
    const nonce = header(req, 'x-agentbridge-nonce') ?? '';
    if (!hasValidHookSignature(deps, req) || seen.has(nonce)) {
      onFailure(req);
      return reply.code(401).send({ error: 'invalid hook signature' });
    }
    seen.set(nonce, now + HOOK_AUTH_WINDOW_MS * 2);
    (req as unknown as Record<symbol, boolean>)[AUTHENTICATED] = true;
  };
}

/** onSend hook: attach the response proof for authenticated hook requests. */
export function hookResponseProofHook(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const nonce = header(req, 'x-agentbridge-nonce');
    if (nonce && (req as unknown as Record<symbol, boolean>)[AUTHENTICATED]) {
      const body = typeof payload === 'string' ? payload : payload == null ? '' : null;
      if (body !== null) reply.header('x-agentbridge-proof', hookResponseProof(deps.hookToken, nonce, body));
    }
    return payload;
  };
}

export function checkPassword(deps: AuthDeps, password: unknown): boolean {
  return typeof password === 'string' && password.length <= 1024 && safeEqual(password, deps.dashboardPassword);
}

export function createDashboardSession(deps: AuthDeps, req: FastifyRequest, reply: FastifyReply): void {
  const token = newSecret(32);
  const now = deps.now();
  deps.store.pruneDashboardSessions(now.toISOString());
  deps.store.insertDashboardSession(
    sha256(token),
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    (req.headers['user-agent'] ?? '').slice(0, 200) || null,
  );
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.protocol === 'https',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function destroyDashboardSession(deps: AuthDeps, req: FastifyRequest, reply: FastifyReply): void {
  const token = req.cookies[SESSION_COOKIE];
  if (token) deps.store.deleteDashboardSession(sha256(token));
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function isDashboardAuthenticated(deps: AuthDeps, req: FastifyRequest): boolean {
  const token = req.cookies[SESSION_COOKIE];
  return Boolean(token && deps.store.isDashboardSessionValid(sha256(token), deps.now().toISOString()));
}

/**
 * Dashboard guard: valid session cookie, and for state-changing requests a
 * custom CSRF header (which cross-site forms cannot send) plus an Origin
 * check when the browser supplies one. The cookie is also SameSite=Strict.
 */
export function requireDashboard(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isDashboardAuthenticated(deps, req)) {
      return reply.code(401).send({ error: 'authentication required' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers[CSRF_HEADER] !== '1') {
        return reply.code(403).send({ error: 'missing CSRF header' });
      }
      const origin = req.headers.origin;
      if (origin) {
        let originHost: string | null;
        try {
          originHost = new URL(origin).host;
        } catch {
          originHost = null;
        }
        if (originHost !== req.headers.host) {
          return reply.code(403).send({ error: 'cross-origin request refused' });
        }
      }
    }
  };
}
