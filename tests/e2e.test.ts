/**
 * End-to-end: a real HTTP server + the real compiled hook script run as a
 * child process exactly the way Claude Code runs it (JSON on stdin, decision
 * JSON on stdout), with the mock telephony provider standing in for the
 * phone network. Requires `npm run build:ts` first.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@agentbridge/core';
import { buildApp, startServices, type Services } from '../apps/server/src/app.js';

const HOOK = resolve(__dirname, '../packages/claude-code/dist/hook.js');
const PASSWORD = 'e2e-dashboard-password';
const TOKEN = 'e2e-hook-token-0123456789abcdef';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

beforeAll(() => {
  if (!existsSync(HOOK)) throw new Error('Run `npm run build:ts` before the e2e tests');
});

async function startServer(env: Record<string, string> = {}): Promise<{ base: string; services: Services; cookie: string }> {
  const config = loadConfig({
    AGENTBRIDGE_DATA_DIR: mkdtempSync(join(tmpdir(), 'ab-e2e-')),
    AGENTBRIDGE_DASHBOARD_PASSWORD: PASSWORD,
    AGENTBRIDGE_HOOK_TOKEN: TOKEN,
    TELEPHONY_PROVIDER: 'mock',
    PHONE_TO_NUMBER: '+919876543210',
    ...env,
  });
  const built = await buildApp({ config, logger: false, inMemoryDb: true });
  startServices(built.services);
  app = built.app;
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return { base, services: built.services, cookie };
}

function runHook(base: string, payload: object, env: Record<string, string> = {}): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [HOOK, 'PermissionRequest', '--agentbridge'], {
      env: { ...process.env, AGENTBRIDGE_URL: base, AGENTBRIDGE_HOOK_TOKEN: TOKEN, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolvePromise({ stdout, code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const payload = (command: string, session = 'e2e-session') => ({
  session_id: session,
  transcript_path: '/tmp/t.jsonl',
  cwd: '/home/dev/payments-service',
  permission_mode: 'default',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command, description: 'Install JWT library' },
});

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting');
}

async function mockPhone(base: string, cookie: string, callId: string, action: string, body: object = {}) {
  const res = await fetch(`${base}/api/mock-phone/${callId}/${action}`, {
    method: 'POST',
    headers: { cookie, 'x-agentbridge-csrf': '1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { mock: { transcript: string[]; state: string } };
}

async function ringingCall(base: string, cookie: string) {
  return waitFor(async () => {
    const res = await fetch(`${base}/api/mock-phone`, { headers: { cookie } });
    const { calls } = (await res.json()) as { calls: { callId: string; state: string; decisionId: string }[] };
    return calls.find((c) => c.state === 'ringing');
  });
}

describe('end-to-end approval via (simulated) phone call', () => {
  it('pressing 1 makes the hook print an allow decision for Claude Code', async () => {
    const { base, cookie, services } = await startServer();
    const hook = runHook(base, payload('npm install jsonwebtoken'));
    const call = await ringingCall(base, cookie);
    const answered = await mockPhone(base, cookie, call.callId, 'answer');
    expect(answered.mock.transcript.join(' ')).toMatch(
      /This is AgentBridge calling on behalf of Claude Code\. In the project payments-service, Claude wants to install a new dependency called jsonwebtoken/,
    );
    await mockPhone(base, cookie, call.callId, 'press', { digit: '1' });
    const { stdout, code } = await hook;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    const d = services.decisions.get(call.decisionId)!;
    expect(d).toMatchObject({ status: 'approved', resolutionChannel: 'phone' });
    const audit = services.store.listEvents({ decisionId: d.id }).map((e) => e.type);
    expect(audit).toEqual(expect.arrayContaining(['decision.created', 'call.initiated', 'call.answered', 'call.digits', 'decision.approved']));
  });

  it('pressing 0 makes the hook deny', async () => {
    const { base, cookie } = await startServer();
    const hook = runHook(base, payload('rm -rf ./build'));
    const call = await ringingCall(base, cookie);
    await mockPhone(base, cookie, call.callId, 'answer');
    await mockPhone(base, cookie, call.callId, 'press', { digit: '0' });
    const out = JSON.parse((await hook).stdout);
    expect(out.hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('invalid keys never approve; the hook keeps waiting until a valid answer', async () => {
    const { base, cookie } = await startServer();
    const hook = runHook(base, payload('git push origin main'));
    const call = await ringingCall(base, cookie);
    await mockPhone(base, cookie, call.callId, 'answer');
    const r = await mockPhone(base, cookie, call.callId, 'press', { digit: '9' });
    expect(r.mock.transcript.join(' ')).toContain('not a valid option');
    await mockPhone(base, cookie, call.callId, 'press', { digit: '0' });
    expect(JSON.parse((await hook).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('expiry fails closed: no output (Claude Code shows its own prompt)', async () => {
    const { base, cookie, services } = await startServer();
    const hook = runHook(base, payload('npm publish'));
    const call = await ringingCall(base, cookie);
    services.decisions.expire(call.decisionId);
    const { stdout, code } = await hook;
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('expiry with APPROVAL_TIMEOUT_BEHAVIOR=deny produces an explicit deny', async () => {
    const { base, cookie, services } = await startServer({ APPROVAL_TIMEOUT_BEHAVIOR: 'deny' });
    const hook = runHook(base, payload('npm publish'));
    const call = await ringingCall(base, cookie);
    services.decisions.expire(call.decisionId);
    expect(JSON.parse((await hook).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('a failed call never approves', async () => {
    const { base, services } = await startServer({ CALL_MAX_ATTEMPTS: '1' });
    const provider = services.provider as unknown as { failNextCalls: number };
    provider.failNextCalls = 1;
    const hook = runHook(base, payload('docker system prune -af'));
    const d = await waitFor(async () => services.decisions.list({ status: 'pending' })[0]);
    await waitFor(async () => services.store.listCalls({ decisionId: d.id })[0]?.status === 'failed' || null);
    services.decisions.expire(d.id);
    expect((await hook).stdout.trim()).toBe('');
  });

  it('server unavailable: hook exits cleanly with no decision', async () => {
    const { stdout, code } = await runHook('http://127.0.0.1:9', payload('ls'));
    expect(code).toBe(0);
    expect(stdout.trim()).toBe('');
  });

  it('two sessions waiting at once: each hook gets only its own decision', async () => {
    const { base, cookie, services } = await startServer();
    const hookA = runHook(base, payload('npm install a-lib', 'session-A'));
    const hookB = runHook(base, payload('npm install b-lib', 'session-B'));
    const both = await waitFor(async () => {
      const p = services.decisions.list({ status: 'pending' });
      return p.length === 2 ? p : null;
    });
    const a = both.find((d) => d.sessionId === 'session-A')!;
    const b = both.find((d) => d.sessionId === 'session-B')!;
    const h = { cookie, 'x-agentbridge-csrf': '1', 'content-type': 'application/json' };
    await fetch(`${base}/api/decisions/${b.id}/reject`, { method: 'POST', headers: h, body: '{}' });
    await fetch(`${base}/api/decisions/${a.id}/approve`, { method: 'POST', headers: h, body: '{}' });
    expect(JSON.parse((await hookA).stdout).hookSpecificOutput.decision.behavior).toBe('allow');
    expect(JSON.parse((await hookB).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });
});
