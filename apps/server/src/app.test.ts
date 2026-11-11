import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@agentbridge/core';
import { TwilioProvider, computeTwilioSignature } from '@agentbridge/telephony';
import { randomBytes } from 'node:crypto';
import { signHookRequest, verifyHookResponse } from '@agentbridge/claude-code';
import { buildApp, startServices, type Services } from './app.js';

const PASSWORD = 'correct horse battery staple';
const HOOK_TOKEN = 'test-hook-token-0123456789abcdef';
const TO = '+919876543210';

let current: FastifyInstance | null = null;
afterEach(async () => {
  await current?.close();
  current = null;
});

async function setup(env: Record<string, string> = {}, provider?: TwilioProvider) {
  const config = loadConfig({
    AGENTBRIDGE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ab-server-')),
    AGENTBRIDGE_DASHBOARD_PASSWORD: PASSWORD,
    AGENTBRIDGE_HOOK_TOKEN: HOOK_TOKEN,
    TELEPHONY_PROVIDER: 'mock',
    PHONE_TO_NUMBER: TO,
    CALL_RETRY_DELAY_SECONDS: '0',
    ...env,
  });
  const { app, services } = await buildApp({ config, logger: false, inMemoryDb: true, provider });
  startServices(services);
  current = app;
  return { app, services };
}

async function login(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: PASSWORD } });
  expect(res.statusCode).toBe(200);
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw[0] : raw)!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/SameSite=Strict/i);
  return cookie.split(';')[0]!;
}

function signHeaders(method: string, url: string, token = HOOK_TOKEN, nonce = randomBytes(18).toString('base64url')) {
  const ts = String(Date.now());
  return {
    'x-agentbridge-ts': ts,
    'x-agentbridge-nonce': nonce,
    'x-agentbridge-signature': signHookRequest(token, method, url, ts, nonce),
  };
}

/** Injects a hook API request signed exactly like the real hook client does. */
async function signed(
  app: FastifyInstance,
  opts: { method: 'GET' | 'POST'; url: string; payload?: unknown; headers?: Record<string, string> },
) {
  const headers = { ...signHeaders(opts.method, opts.url), ...opts.headers };
  const res = await app.inject({ ...opts, headers, payload: opts.payload as Record<string, unknown> });
  // Every authenticated response must carry a valid proof for the hook to accept it.
  expect(
    verifyHookResponse(HOOK_TOKEN, headers['x-agentbridge-nonce'], res.body, (res.headers['x-agentbridge-proof'] as string) ?? null),
  ).toBe(res.statusCode !== 401);
  return res;
}
const permission = (over: Record<string, unknown> = {}) => ({
  sessionId: 'session-1',
  cwd: '/work/shop-api',
  toolName: 'Bash',
  toolInput: { command: 'npm install jsonwebtoken' },
  ...over,
});

async function createDecision(app: FastifyInstance, over: Record<string, unknown> = {}) {
  const res = await signed(app, { method: 'POST', url: '/api/hooks/permission-request', payload: permission(over) });
  expect(res.statusCode).toBe(201);
  return res.json() as { decisionId: string; status: string; timeoutBehavior: string };
}

describe('authentication', () => {
  it('rejects wrong passwords and protects every dashboard endpoint', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'nope' } })).statusCode).toBe(401);
    for (const url of ['/api/overview', '/api/decisions', '/api/sessions', '/api/calls', '/api/events', '/api/stream', '/api/mock-phone']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    const cookie = await login(app);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('rejects forged session cookies', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: 'ab_session=forged' } });
    expect(res.statusCode).toBe(401);
  });

  it('requires the CSRF header and same origin for mutations', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const { decisionId } = await createDecision(app);
    const url = `/api/decisions/${decisionId}/approve`;
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: {} })).statusCode).toBe(403);
    const crossOrigin = await app.inject({
      method: 'POST',
      url,
      headers: { cookie, 'x-agentbridge-csrf': '1', origin: 'https://evil.example', host: 'localhost:4317' },
      payload: {},
    });
    expect(crossOrigin.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/decisions/${decisionId}`, headers: { cookie } })).json().decision.status).toBe('pending');
  });

  it('logout invalidates the session', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-agentbridge-csrf': '1' }, payload: {} })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).statusCode).toBe(401);
  });

  it('rate limits login attempts', async () => {
    const { app } = await setup();
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { password: 'wrong' } })).statusCode;
    }
    expect(last).toBe(429);
  });

  it('requires a valid, fresh, single-use hook signature (the token itself is never sent)', async () => {
    const { app } = await setup();
    const url = '/api/hooks/permission-request';
    const unsigned = await app.inject({ method: 'POST', url, payload: permission() });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.headers['x-agentbridge-proof']).toBeUndefined();
    const bearer = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${HOOK_TOKEN}` }, payload: permission() });
    expect(bearer.statusCode).toBe(401);
    const wrongKey = await app.inject({ method: 'POST', url, headers: signHeaders('POST', url, 'x'.repeat(32)), payload: permission() });
    expect(wrongKey.statusCode).toBe(401);
    const otherPath = await app.inject({ method: 'POST', url, headers: signHeaders('POST', '/api/hooks/event'), payload: permission() });
    expect(otherPath.statusCode).toBe(401);
    const h = signHeaders('POST', url);
    expect((await app.inject({ method: 'POST', url, headers: h, payload: permission() })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url, headers: h, payload: permission() })).statusCode).toBe(401); // replayed nonce
  });

  it('only exposes the telephony webhooks through the public tunnel', async () => {
    const { app } = await setup({ AGENTBRIDGE_PUBLIC_URL: 'https://bridge.example.com' });
    const viaTunnel = { host: 'bridge.example.com', 'cf-connecting-ip': '203.0.113.9' };
    for (const [method, url] of [
      ['GET', '/'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/overview'],
      ['POST', '/api/hooks/permission-request'],
    ] as const) {
      expect((await app.inject({ method, url, headers: viaTunnel, payload: method === 'POST' ? {} : undefined })).statusCode, url).toBe(404);
    }
    const webhook = await app.inject({ method: 'POST', url: '/telephony/mock/call_x/voice', headers: viaTunnel, payload: {} });
    expect(webhook.statusCode).toBe(403); // reached the webhook route, refused for lack of a signature
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200); // local still fine
  });

  it('sets security headers', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('hook ingestion and dashboard decisions', () => {
  it('validates hook input', async () => {
    const { app } = await setup();
    const res = await signed(app, {
      method: 'POST',
      url: '/api/hooks/permission-request',
      payload: { sessionId: '', toolName: 'Bash', toolInput: 'rm -rf /' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('ingests a permission request, deduplicates it, and returns the timeout behaviour', async () => {
    const { app } = await setup({ APPROVAL_TIMEOUT_BEHAVIOR: 'deny' });
    const a = await createDecision(app);
    expect(a.status).toBe('pending');
    expect(a.timeoutBehavior).toBe('deny');
    const dup = await signed(app, { method: 'POST', url: '/api/hooks/permission-request', payload: permission() });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ decisionId: a.decisionId, duplicate: true });
  });

  it('dashboard approval reaches the waiting hook', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const { decisionId } = await createDecision(app);
    const waiting = signed(app, { method: 'GET', url: `/api/hooks/decisions/${decisionId}/wait?timeoutMs=5000` });
    const res = await app.inject({
      method: 'POST',
      url: `/api/decisions/${decisionId}/approve`,
      headers: { cookie, 'x-agentbridge-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect((await waiting).json()).toMatchObject({ decisionId, status: 'approved', resolutionChannel: 'dashboard' });
  });

  it('dashboard rejection; second decision is refused with 409', async () => {
    const { app } = await setup();
    const cookie = await login(app);
    const { decisionId } = await createDecision(app);
    const h = { cookie, 'x-agentbridge-csrf': '1' };
    expect((await app.inject({ method: 'POST', url: `/api/decisions/${decisionId}/reject`, headers: h, payload: {} })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: `/api/decisions/${decisionId}/approve`, headers: h, payload: {} });
    expect(again.statusCode).toBe(409);
    const wait = await signed(app, { method: 'GET', url: `/api/hooks/decisions/${decisionId}/wait?timeoutMs=10` });
    expect(wait.json().status).toBe('rejected');
  });

  it('expired decisions cannot be approved from the dashboard', async () => {
    const { app, services } = await setup();
    const cookie = await login(app);
    const { decisionId } = await createDecision(app);
    services.decisions.expire(decisionId);
    const res = await app.inject({
      method: 'POST',
      url: `/api/decisions/${decisionId}/approve`,
      headers: { cookie, 'x-agentbridge-csrf': '1' },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(services.decisions.get(decisionId)!.status).toBe('expired');
  });

  it('tracks sessions and lifecycle events; ending a session cancels its pending decisions', async () => {
    const { app, services } = await setup();
    const post = (event: string, payload: Record<string, unknown>) =>
      signed(app, { method: 'POST', url: '/api/hooks/event', payload: { event, payload: { session_id: 'session-1', cwd: '/work/shop-api', ...payload } } });
    expect((await post('SessionStart', { source: 'startup', model: 'claude-opus-5-5' })).statusCode).toBe(204);
    const { decisionId } = await createDecision(app);
    await post('Stop', { last_assistant_message: 'Done. token=abc123secretvalue' });
    await post('StopFailure', { error: 'rate_limit', error_details: '429' });
    await post('SessionEnd', { reason: 'logout' });
    expect(services.decisions.get(decisionId)!.status).toBe('cancelled');
    const session = services.sessions.get('session-1')!;
    expect(session.status).toBe('ended');
    expect(session.model).toBe('claude-opus-5-5');
    const types = services.store.listEvents({ limit: 50 }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session.started', 'task.completed', 'task.failed', 'session.ended', 'decision.cancelled']));
    const completed = services.store.listEvents({ limit: 50 }).find((e) => e.type === 'task.completed')!;
    expect(completed.message).not.toContain('abc123secretvalue');
  });
});

describe('telephony webhooks over HTTP', () => {
  it('rejects unsigned and mis-signed Twilio webhooks', async () => {
    const authToken = 'twilio-test-auth-token';
    const provider = new TwilioProvider({
      accountSid: `AC${'1'.repeat(32)}`,
      authToken,
      fromNumber: '+15005550006',
      fetchImpl: (async () => new Response(JSON.stringify({ sid: 'CA_test_1' }), { status: 201 })) as unknown as typeof fetch,
    });
    const { app, services } = await setup({ TELEPHONY_PROVIDER: 'twilio', AGENTBRIDGE_PUBLIC_URL: 'https://bridge.example.com' }, provider);
    const { decisionId } = await createDecision(app);
    await new Promise((r) => setTimeout(r, 20));
    const call = services.store.listCalls({ decisionId })[0]!;
    expect(call.providerCallId).toBe('CA_test_1');
    const path = `/telephony/twilio/${call.id}/gather?seq=1`;
    const params = { CallSid: 'CA_test_1', To: TO, Digits: '1' };

    const unsigned = await app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams(params).toString() });
    expect(unsigned.statusCode).toBe(403);

    const badSig = computeTwilioSignature('wrong-token', `https://bridge.example.com${path}`, params);
    const forged = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': badSig },
      payload: new URLSearchParams(params).toString(),
    });
    expect(forged.statusCode).toBe(403);
    expect(services.decisions.get(decisionId)!.status).toBe('pending');

    // Correctly signed answer + key press via the real HTTP route approves.
    const sign = (p: string, prm: Record<string, string>) => computeTwilioSignature(authToken, `https://bridge.example.com${p}`, prm);
    const voicePath = `/telephony/twilio/${call.id}/voice?seq=0&reason=answer`;
    const voiceParams = { CallSid: 'CA_test_1', To: TO, CallStatus: 'in-progress' };
    const voice = await app.inject({
      method: 'POST',
      url: voicePath,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(voicePath, voiceParams) },
      payload: new URLSearchParams(voiceParams).toString(),
    });
    expect(voice.statusCode).toBe(200);
    expect(voice.headers['content-type']).toContain('text/xml');
    expect(voice.body).toContain('<Gather input="dtmf"');
    const ok = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(path, params) },
      payload: new URLSearchParams(params).toString(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('Approved.');
    expect(services.decisions.get(decisionId)!.status).toBe('approved');

    // Exact replay of the accepted webhook is ignored.
    const replay = await app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(path, params) },
      payload: new URLSearchParams(params).toString(),
    });
    expect(replay.body).not.toContain('Approved.');
  });

  it('mock handset endpoints drive the signed webhook flow', async () => {
    const { app, services }: { app: FastifyInstance; services: Services } = await setup();
    const cookie = await login(app);
    const h = { cookie, 'x-agentbridge-csrf': '1' };
    const { decisionId } = await createDecision(app);
    await new Promise((r) => setTimeout(r, 20));
    const list = (await app.inject({ method: 'GET', url: '/api/mock-phone', headers: { cookie } })).json() as { calls: { callId: string; decisionId: string; state: string }[] };
    expect(list.calls[0]).toMatchObject({ decisionId, state: 'ringing' });
    const callId = list.calls[0]!.callId;
    const answered = await app.inject({ method: 'POST', url: `/api/mock-phone/${callId}/answer`, headers: h, payload: {} });
    expect(answered.json().mock.transcript.join(' ')).toContain('install a new dependency called jsonwebtoken');
    const bad = await app.inject({ method: 'POST', url: `/api/mock-phone/${callId}/press`, headers: h, payload: { digit: '12' } });
    expect(bad.statusCode).toBe(400);
    const pressed = await app.inject({ method: 'POST', url: `/api/mock-phone/${callId}/press`, headers: h, payload: { digit: '0' } });
    expect(pressed.json().mock.state).toBe('ended');
    expect(services.decisions.get(decisionId)!.status).toBe('rejected');
    const overview = (await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie } })).json();
    expect(overview.provider).toMatchObject({ name: 'mock', isRealCall: false, enabled: true, toMasked: '+91******3210' });
    expect(JSON.stringify(overview)).not.toContain(TO);
    expect(JSON.stringify(overview)).not.toContain(HOOK_TOKEN);
  });
});
