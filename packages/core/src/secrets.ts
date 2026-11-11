import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newSecret } from './ids.js';

export const HOOK_TOKEN_FILE = 'hook-token';
export const DASHBOARD_PASSWORD_FILE = 'dashboard-password';

export function defaultDataDir(): string {
  return process.env.AGENTBRIDGE_DATA_DIR ?? join(homedir(), '.agentbridge');
}

/**
 * Returns `explicit` when set (env var), otherwise reads `<dataDir>/<file>`,
 * generating a fresh random secret with owner-only permissions on first use.
 * Secret values are never logged.
 */
export function loadOrCreateSecret(
  dataDir: string,
  file: string,
  explicit: string | null,
): { value: string; source: 'env' | 'file' | 'generated'; path: string } {
  const path = join(dataDir, file);
  if (explicit) return { value: explicit, source: 'env', path };
  if (existsSync(path)) {
    const value = readFileSync(path, 'utf8').trim();
    if (value.length >= 24) return { value, source: 'file', path };
  }
  mkdirSync(dataDir, { recursive: true });
  const value = newSecret(32);
  writeFileSync(path, `${value}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* best effort on Windows */
  }
  return { value, source: 'generated', path };
}
