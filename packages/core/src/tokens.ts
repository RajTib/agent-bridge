import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

/**
 * Signed, single-use*, expiring tokens for pending approvals -- replaces
 * the shared-secret-topic-name pattern most existing bridge tools use (see
 * docs/security.md). *Single-use is enforced by the relay's state machine
 * (relay.ts), not by this module -- a valid signature can always be
 * replayed unless something server-side tracks whether it's already been
 * consumed.
 */
function sign(approvalId: string, expiresAtMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${approvalId}.${expiresAtMs}`).digest('hex');
}

export function issueToken(approvalId: string, ttlMs: number, secret: string): IssuedToken {
  const expiresAtMs = Date.now() + ttlMs;
  const signature = sign(approvalId, expiresAtMs, secret);
  return {
    token: `${approvalId}.${expiresAtMs}.${signature}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export interface TokenVerification {
  valid: boolean;
  reason?: 'malformed' | 'bad_signature' | 'expired';
  approvalId?: string;
}

/** Verifies signature + expiry. Does NOT check single-use -- see relay.ts. */
export function verifyToken(token: string, secret: string): TokenVerification {
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };

  const [approvalId, expiresAtStr, signature] = parts;
  const expiresAtMs = Number(expiresAtStr);
  if (!approvalId || !signature || !Number.isFinite(expiresAtMs)) {
    return { valid: false, reason: 'malformed' };
  }

  const expected = sign(approvalId, expiresAtMs, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  const signatureOk =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

  if (!signatureOk) return { valid: false, reason: 'bad_signature', approvalId };
  if (Date.now() > expiresAtMs) return { valid: false, reason: 'expired', approvalId };

  return { valid: true, approvalId };
}
