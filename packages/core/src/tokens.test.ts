import { describe, expect, it } from 'vitest';
import { issueToken, verifyToken } from './tokens';

const SECRET = 'test-secret';

describe('tokens', () => {
  it('issues a token that verifies successfully', () => {
    const { token } = issueToken('appr-1', 60_000, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result.valid).toBe(true);
    expect(result.approvalId).toBe('appr-1');
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = issueToken('appr-1', 60_000, SECRET);
    const result = verifyToken(token, 'wrong-secret');
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects a tampered approvalId (signature no longer matches)', () => {
    const { token } = issueToken('appr-1', 60_000, SECRET);
    const [, expiresAt, signature] = token.split('.');
    const tampered = `appr-2.${expiresAt}.${signature}`;
    const result = verifyToken(tampered, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const { token } = issueToken('appr-1', -1, SECRET); // already expired
    const result = verifyToken(token, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('rejects a malformed token', () => {
    expect(verifyToken('not-even-three-parts', SECRET).reason).toBe('malformed');
    expect(verifyToken('a.b', SECRET).reason).toBe('malformed');
    expect(verifyToken('a.not-a-number.sig', SECRET).reason).toBe('malformed');
  });
});
