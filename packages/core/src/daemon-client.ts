import type { ApprovalOutcome, NormalizedEvent } from '@agentbridge/contracts';
import { loadOrCreateDaemonSecret } from './secret';
import { DEFAULT_PORT } from './daemon';

function baseUrl(): string {
  const port = Number(process.env.AGENTBRIDGE_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Quick, short-timeout check used by `agentbridge hook` to decide whether to fail safe. */
export async function isDaemonRunning(timeoutMs = 500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      headers: { 'x-agentbridge-secret': loadOrCreateDaemonSecret() },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export type SubmitEventResult = ApprovalOutcome | { logged: true };

/**
 * Submits a normalized event to the running daemon and waits for the
 * outcome. For permission_required events this can legitimately take up to
 * the configured approval timeout (default 300s), so the request gets
 * generous headroom rather than relying on any client default.
 */
export async function submitEvent(event: NormalizedEvent, timeoutMs = 310_000): Promise<SubmitEventResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agentbridge-secret': loadOrCreateDaemonSecret(),
      },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`daemon responded with HTTP ${res.status}`);
    }
    return (await res.json()) as SubmitEventResult;
  } finally {
    clearTimeout(timer);
  }
}
