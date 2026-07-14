import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '@agentbridge/adapter-claude-code';

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

/**
 * Temporary stand-in for the real relay hand-off (step 5, the core relay).
 * Normalizes the incoming hook payload and appends it to a local debug log,
 * then exits 0 — it never blocks Claude Code. This exists so we can prove
 * the normalizer works against real hook payloads before the core relay and
 * Discord adapter exist. Once the relay is built, this command gets replaced
 * with one that actually submits the event and waits for a decision.
 */
export async function runDebugHook(): Promise<void> {
  const raw = await readStdin();

  let event;
  try {
    event = claudeCodeAdapter.normalize(JSON.parse(raw));
  } catch (err) {
    // Never break the user's Claude Code session over a logging problem.
    console.error(`agentbridge hook: ${(err as Error).message}`);
    process.exitCode = 0;
    return;
  }

  const dir = join(homedir(), '.agentbridge');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(join(dir, 'events.debug.jsonl'), `${JSON.stringify(event)}\n`, 'utf-8');

  process.exitCode = 0;
}
