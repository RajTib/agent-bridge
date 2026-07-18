import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_SECRET_PATH = join(homedir(), '.agentbridge', 'daemon-secret');

/**
 * A shared local secret the daemon and the `agentbridge hook` CLI both read,
 * so a request to the daemon's local HTTP API has to know a value that
 * isn't just "whatever's listening on this port" (see docs/security.md).
 * Distinct from the signed, single-use, per-approval tokens in tokens.ts --
 * this one just proves "you're a legitimate AgentBridge process on this
 * machine," not "you're allowed to decide this specific approval."
 */
export function loadOrCreateDaemonSecret(path: string = DEFAULT_SECRET_PATH): string {
  if (existsSync(path)) {
    return readFileSync(path, 'utf-8').trim();
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(path, secret, 'utf-8');
  return secret;
}
