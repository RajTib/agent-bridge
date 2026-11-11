import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 128 bits of CSPRNG output, base64url. Used for decision and call ids, which
 * appear in telephony webhook URLs and must therefore be unguessable.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh) && a.length === b.length;
}

/** Deterministic JSON (sorted keys) so equal tool inputs hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}
