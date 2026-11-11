#!/usr/bin/env node
/**
 * AgentBridge hook client, invoked by Claude Code:
 *
 *   node ".../packages/claude-code/dist/hook.js" <HookEventName> --agentbridge
 *
 * PermissionRequest: forwards the request to the AgentBridge server, long-polls
 * until a human approves/rejects (phone call or dashboard) or the decision
 * expires, then prints Claude Code's PermissionRequest decision JSON.
 *
 * Every other event is forwarded fire-and-forget for session tracking and
 * notifications, and never affects Claude Code.
 *
 * FAIL-CLOSED: if anything goes wrong this process prints no allow decision.
 * Claude Code then falls back to its normal permission prompt (or denies, in
 * non-interactive mode), or -- with APPROVAL_TIMEOUT_BEHAVIOR=deny -- we deny.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PASSTHROUGH_TOOLS, type HookDecisionResponse } from '@agentbridge/shared';
import { interpretDecisionResponse, renderPermissionOutput, type HookOutcome } from './output.js';

const DEFAULT_URL = 'http://127.0.0.1:4317';

export interface HookEnv {
  baseUrl: string;
  token: string | null;
  fallbackTimeoutBehavior: 'ask' | 'deny';
}

export function resolveHookEnv(env: NodeJS.ProcessEnv = process.env): HookEnv {
  const baseUrl = (env.AGENTBRIDGE_URL ?? (env.AGENTBRIDGE_PORT ? `http://127.0.0.1:${env.AGENTBRIDGE_PORT}` : DEFAULT_URL)).replace(/\/+$/, '');
  let token = env.AGENTBRIDGE_HOOK_TOKEN?.trim() || null;
  if (!token) {
    const dataDir = env.AGENTBRIDGE_DATA_DIR ?? join(homedir(), '.agentbridge');
    const file = join(dataDir, 'hook-token');
    if (existsSync(file)) token = readFileSync(file, 'utf8').trim() || null;
  }
  const fallbackTimeoutBehavior = env.APPROVAL_TIMEOUT_BEHAVIOR === 'deny' ? 'deny' : 'ask';
  return { baseUrl, token, fallbackTimeoutBehavior };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function request(
  env: HookEnv,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${env.baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(env.token ? { authorization: `Bearer ${env.token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PermissionRun {
  outcome: HookOutcome;
  timeoutBehavior: 'ask' | 'deny';
}

/** Creates the decision and waits for it. Exported for end-to-end tests. */
export async function runPermissionRequest(
  payload: Record<string, unknown>,
  env: HookEnv,
  opts: { pollMs?: number; log?: (m: string) => void } = {},
): Promise<PermissionRun> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`[agentbridge] ${m}\n`));
  let timeoutBehavior = env.fallbackTimeoutBehavior;
  const unresolved = (reason: string): PermissionRun => ({
    outcome: { kind: 'unresolved', reason },
    timeoutBehavior,
  });

  if (!env.token) return unresolved('no hook token configured');

  let created: HookDecisionResponse;
  try {
    const res = await request(
      env,
      'POST',
      '/api/hooks/permission-request',
      {
        sessionId: payload.session_id,
        cwd: payload.cwd ?? null,
        toolName: payload.tool_name,
        toolInput: payload.tool_input ?? {},
        permissionMode: payload.permission_mode ?? null,
      },
      8000,
    );
    if (res.status !== 200 && res.status !== 201) {
      log(`server refused the permission request (HTTP ${res.status})`);
      return unresolved(`server returned HTTP ${res.status}`);
    }
    created = res.json as HookDecisionResponse;
    if (!created || typeof created.decisionId !== 'string') return unresolved('malformed server response');
    timeoutBehavior = created.timeoutBehavior === 'deny' ? 'deny' : 'ask';
  } catch (err) {
    log(`AgentBridge server unreachable at ${env.baseUrl}: ${(err as Error).message}`);
    return unresolved('AgentBridge server unreachable');
  }

  const decisionId = created.decisionId;
  const first = interpretDecisionResponse(decisionId, created);
  if (first) return { outcome: first, timeoutBehavior };

  // Hard local deadline: never wait past the server-side expiry (+ small grace).
  const deadline = Date.parse(created.expiresAt) + 5_000;
  const pollMs = opts.pollMs ?? 20_000;
  let failures = 0;

  while (Date.now() < deadline) {
    const waitMs = Math.max(250, Math.min(pollMs, deadline - Date.now()));
    try {
      const res = await request(
        env,
        'GET',
        `/api/hooks/decisions/${encodeURIComponent(decisionId)}/wait?timeoutMs=${waitMs}`,
        undefined,
        waitMs + 10_000,
      );
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      failures = 0;
      const outcome = interpretDecisionResponse(decisionId, res.json);
      if (outcome) return { outcome, timeoutBehavior };
    } catch (err) {
      failures++;
      log(`poll failed (${failures}): ${(err as Error).message}`);
      // Tolerate a brief server restart; give up (fail closed) if it persists.
      if (failures >= 10) return unresolved('lost contact with AgentBridge server');
      await sleep(Math.min(1000 * failures, 5000));
    }
  }
  return unresolved('approval timed out');
}

async function forwardEvent(eventName: string, payload: Record<string, unknown>, env: HookEnv): Promise<void> {
  if (!env.token) return;
  try {
    await request(env, 'POST', '/api/hooks/event', { event: eventName, payload }, 2500);
  } catch {
    // Informational only -- never block or fail Claude Code over a notification.
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const env = resolveHookEnv();
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readStdin()) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('payload is not an object');
    payload = parsed as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(`[agentbridge] could not parse hook payload: ${(err as Error).message}\n`);
    return; // no output -> Claude Code's normal behaviour
  }

  const eventName = String(payload.hook_event_name ?? argv[0] ?? '');

  if (eventName !== 'PermissionRequest') {
    await forwardEvent(eventName, payload, env);
    return;
  }

  if (typeof payload.tool_name !== 'string' || PASSTHROUGH_TOOLS.includes(payload.tool_name)) {
    return; // needs interactive input; leave it to Claude Code's own prompt
  }

  const { outcome, timeoutBehavior } = await runPermissionRequest(payload, env);
  const output = renderPermissionOutput(outcome, timeoutBehavior);
  if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
}

const invokedDirectly = (() => {
  const entry = process.argv[1] ?? '';
  return /hook\.(js|ts)$/.test(entry.replace(/\\/g, '/'));
})();

if (invokedDirectly) {
  main()
    .catch((err) => {
      process.stderr.write(`[agentbridge] hook error: ${(err as Error).message}\n`);
    })
    .finally(() => {
      process.exitCode = 0;
    });
}
