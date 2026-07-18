import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '@agentbridge/adapter-claude-code';
import { isDaemonRunning, submitEvent } from '@agentbridge/core';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function logToDebugFile(event: unknown): void {
  const dir = join(homedir(), '.agentbridge');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, 'events.debug.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8');
}

/**
 * Real hook entrypoint (replaces the step-3 debug-only placeholder):
 * normalizes the incoming Claude Code hook payload, submits it to the core
 * relay daemon, and waits for the outcome. If the daemon isn't reachable,
 * fails safe -- logs locally and tells Claude Code to fall back to its own
 * normal interactive prompt. Never silently blocks or auto-approves.
 */
export async function runHook(): Promise<void> {
  const raw = await readStdin();

  let event;
  try {
    event = claudeCodeAdapter.normalize(JSON.parse(raw));
  } catch (err) {
    console.error(`agentbridge hook: ${(err as Error).message}`);
    process.exitCode = 0;
    return;
  }

  logToDebugFile(event); // always keep a local trace, independent of the daemon

  if (!(await isDaemonRunning())) {
    console.error('agentbridge hook: daemon not reachable -- falling back to the normal prompt.');
    claudeCodeAdapter.deliverOutcome({
      approvalId: 'no-daemon',
      decision: 'timed_out',
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  const result = await submitEvent(event);

  if ('logged' in result) {
    // Notification/run_completed/run_failed -- nothing for Claude Code to act on.
    process.exitCode = 0;
    return;
  }

  claudeCodeAdapter.deliverOutcome(result);
}
