import type { FastifyReply, FastifyRequest } from 'fastify';
import { CSRF_HEADER } from '@agentbridge/shared';
import { newSecret, safeEqual, sha256, type Store } from '@agentbridge/core';

export const SESSION_COOKIE = 'ab_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface AuthDeps {
  store: Store;
  hookToken: string;
  dashboardPassword: string;
  now: () => Date;
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/** Hook client authentication: a shared bearer token, compared in constant time. */
export function requireHookToken(deps: AuthDeps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, deps.hookToken)) {
      return reply.code(401).send({ error: 'invalid hook token' });
    }
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
