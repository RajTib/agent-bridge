/**
 * Pure translation from an AgentBridge outcome to Claude Code's documented
 * PermissionRequest hook output:
 *
 *   { "hookSpecificOutput": { "hookEventName": "PermissionRequest",
 *       "decision": { "behavior": "allow" | "deny", "message"?: string } } }
 *
 * Safety rules enforced here:
 *  - `allow` is produced ONLY for an explicit `approved` outcome whose
 *    decision id matches the one this hook created.
 *  - No `updatedInput` (the exact action reviewed is the action run) and no
 *    `updatedPermissions` (approving once never adds a permanent allow rule).
 *  - Anything else (timeout, cancellation, server down, garbage response)
 *    yields either no output -- Claude Code then shows its normal permission
 *    prompt, and in non-interactive mode denies -- or an explicit deny.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Mutual authentication between the hook and the server without ever sending
 * the token itself. A process squatting on the server's port therefore can
 * neither steal the token nor forge an "approved" response.
 *
 *   request  headers: x-agentbridge-ts, x-agentbridge-nonce,
 *                     x-agentbridge-signature = HMAC(token, method\npath\nts\nnonce)
 *   response header:  x-agentbridge-proof     = HMAC(token, "response"\nnonce\nbody)
 */
export const HOOK_AUTH_WINDOW_MS = 5 * 60 * 1000;

function hmac(token: string, data: string): string {
  return createHmac('sha256', token).update(data).digest('hex');
}

function sameHex(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function signHookRequest(token: string, method: string, path: string, ts: string, nonce: string): string {
  return hmac(token, `${method.toUpperCase()}\n${path}\n${ts}\n${nonce}`);
}

export function verifyHookRequest(
  token: string,
  h: { method: string; path: string; ts?: string; nonce?: string; signature?: string },
  now = Date.now(),
): boolean {
  if (!h.ts || !h.nonce || !h.signature || h.nonce.length < 16 || h.nonce.length > 128) return false;
  const ts = Number(h.ts);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > HOOK_AUTH_WINDOW_MS) return false;
  return sameHex(h.signature, signHookRequest(token, h.method, h.path, h.ts, h.nonce));
}

export function hookResponseProof(token: string, nonce: string, body: string): string {
  return hmac(token, `response\n${nonce}\n${body}`);
}

export function verifyHookResponse(token: string, nonce: string, body: string, proof: string | null): boolean {
  return Boolean(proof) && sameHex(proof!, hookResponseProof(token, nonce, body));
}

export type HookOutcome =
  | { kind: 'approved'; decisionId: string; via: string | null }
  | { kind: 'rejected'; decisionId: string; via: string | null; note: string | null }
  | { kind: 'unresolved'; reason: string };

export interface PermissionRequestOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt?: boolean };
  };
}

export function renderPermissionOutput(
  outcome: HookOutcome,
  timeoutBehavior: 'ask' | 'deny',
): PermissionRequestOutput | null {
  switch (outcome.kind) {
    case 'approved':
      return {
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
      };
    case 'rejected':
      return {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: {
            behavior: 'deny',
            message:
              `The developer rejected this action via AgentBridge${outcome.via ? ` (${outcome.via})` : ''}.` +
              ' Do not retry it; continue without it or ask the developer how to proceed.',
          },
        },
      };
    case 'unresolved':
      if (timeoutBehavior === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: {
              behavior: 'deny',
              message: `AgentBridge did not receive an approval (${outcome.reason}), so this action was not approved.`,
            },
          },
        };
      }
      return null;
  }
}

/**
 * Interprets a server response defensively. Anything that is not an exact,
 * well-formed approval for *our* decision id is treated as not approved.
 */
export function interpretDecisionResponse(expectedId: string, body: unknown): HookOutcome | null {
  if (!body || typeof body !== 'object') return { kind: 'unresolved', reason: 'malformed response' };
  const b = body as Record<string, unknown>;
  if (b.decisionId !== expectedId) return { kind: 'unresolved', reason: 'decision id mismatch' };
  const via = typeof b.resolutionChannel === 'string' ? b.resolutionChannel : null;
  switch (b.status) {
    case 'approved':
      return { kind: 'approved', decisionId: expectedId, via };
    case 'rejected':
      return {
        kind: 'rejected',
        decisionId: expectedId,
        via,
        note: typeof b.resolutionNote === 'string' ? b.resolutionNote : null,
      };
    case 'pending':
      return null; // keep waiting
    case 'expired':
      return { kind: 'unresolved', reason: 'approval timed out' };
    case 'cancelled':
      return { kind: 'unresolved', reason: 'request cancelled' };
    default:
      return { kind: 'unresolved', reason: 'unknown status' };
  }
}
