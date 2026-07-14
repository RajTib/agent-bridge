import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeCodeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

type HookEvent = 'PreToolUse' | 'Notification' | 'Stop';

const HOOK_EVENTS: HookEvent[] = ['PreToolUse', 'Notification', 'Stop'];
const MARKER = 'agentbridge';

const SUBCOMMAND: Record<HookEvent, string> = {
  PreToolUse: 'pre-tool-use',
  Notification: 'notification',
  Stop: 'stop',
};

function commandFor(event: HookEvent): string {
  return `agentbridge hook ${SUBCOMMAND[event]}`;
}

function isOurHookGroup(group: HookGroup): boolean {
  return group.hooks.some((h) => h.command.includes(MARKER));
}

/**
 * Pure merge: adds AgentBridge's hook commands into an existing settings.json
 * object without disturbing any hooks the user already configured. Safe to
 * call repeatedly — re-running never adds a duplicate entry (it replaces its
 * own previous entry in place instead).
 */
export function mergeHooksIntoSettings(settings: ClaudeCodeSettings): ClaudeCodeSettings {
  const hooks: Record<string, HookGroup[]> = { ...(settings.hooks ?? {}) };

  for (const event of HOOK_EVENTS) {
    const existingGroups = hooks[event] ?? [];
    const withoutOurs = existingGroups.filter((g) => !isOurHookGroup(g));
    const ourGroup: HookGroup = {
      hooks: [{ type: 'command', command: commandFor(event), timeout: 600 }],
    };
    // Only PreToolUse/PostToolUse are tool-scoped in Claude Code's hooks
    // system; Notification and Stop fire globally and don't take a matcher.
    if (event === 'PreToolUse') {
      ourGroup.matcher = '*';
    }
    hooks[event] = [...withoutOurs, ourGroup];
  }

  return { ...settings, hooks };
}

/**
 * Reads ~/.claude/settings.json (creating an empty one if it doesn't exist),
 * merges in AgentBridge's hooks, and writes it back. Never touches any other
 * key in the file.
 */
export function installHooks(settingsPath = join(homedir(), '.claude', 'settings.json')): void {
  const dir = dirname(settingsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const existing: ClaudeCodeSettings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, 'utf-8')) as ClaudeCodeSettings)
    : {};

  const updated = mergeHooksIntoSettings(existing);
  writeFileSync(settingsPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf-8');
}
