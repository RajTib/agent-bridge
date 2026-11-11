import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface HookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export interface ClaudeSettings {
  hooks?: Record<string, HookGroup[]>;
  [key: string]: unknown;
}

/** Appended to every command we install so we can find (and only touch) our own entries. */
export const MARKER = '--agentbridge';

/**
 * PermissionRequest is the gate: it fires only when Claude Code would show a
 * permission prompt, so existing allow/deny/ask rules are respected and we
 * never approve something Claude Code would have allowed or blocked anyway.
 * (PreToolUse fires for every tool call and an "allow" there would bypass
 * the permission system, which is exactly what we must not do.)
 *
 * The other events are informational: session tracking + notifications.
 */
export const INSTALLED_EVENTS = [
  'PermissionRequest',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'Stop',
  'StopFailure',
] as const;

export function defaultHookScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), 'hook.js');
}

export function hookCommand(scriptPath: string, event: string): string {
  // Forward slashes work in Git Bash, cmd and POSIX shells alike.
  return `node "${scriptPath.replace(/\\/g, '/')}" ${event} ${MARKER}`;
}

function isOurs(group: HookGroup): boolean {
  return (group.hooks ?? []).some(
    (h) =>
      typeof h.command === 'string' &&
      (h.command.includes(MARKER) || /\bagentbridge hook\b/.test(h.command)), // v0 entries
  );
}

export interface MergeOptions {
  scriptPath: string;
  /** Seconds Claude Code waits for the PermissionRequest hook. Must exceed the approval timeout. */
  permissionTimeoutSeconds: number;
}

/**
 * Pure merge: returns a copy of `settings` with AgentBridge's hooks installed,
 * replacing any previous AgentBridge entries and leaving every other key and
 * every third-party hook untouched. Idempotent.
 */
export function mergeHooks(settings: ClaudeSettings, opts: MergeOptions): ClaudeSettings {
  // Start from a copy with every previous AgentBridge entry (any event) removed.
  const hooks: Record<string, HookGroup[]> = { ...(removeHooks(settings).hooks ?? {}) };
  for (const event of INSTALLED_EVENTS) {
    const others = hooks[event] ?? [];
    const timeout =
      event === 'PermissionRequest' ? opts.permissionTimeoutSeconds : event === 'SessionEnd' ? 5 : 10;
    const group: HookGroup = {
      hooks: [{ type: 'command', command: hookCommand(opts.scriptPath, event), timeout }],
    };
    if (event === 'PermissionRequest') group.matcher = '*';
    hooks[event] = [...others, group];
  }
  return { ...settings, hooks };
}

/** Pure removal of AgentBridge entries (and v0 `agentbridge hook` entries). */
export function removeHooks(settings: ClaudeSettings): ClaudeSettings {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length) hooks[event] = kept;
  }
  const next: ClaudeSettings = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  return next;
}

export function settingsPathFor(scope: { project?: string }): string {
  return scope.project
    ? join(resolve(scope.project), '.claude', 'settings.local.json')
    : join(homedir(), '.claude', 'settings.json');
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object; refusing to modify it`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(path: string, settings: ClaudeSettings): string | null {
  mkdirSync(dirname(path), { recursive: true });
  let backup: string | null = null;
  if (existsSync(path)) {
    backup = `${path}.agentbridge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return backup;
}

export function installHooks(opts: {
  settingsPath: string;
  scriptPath?: string;
  permissionTimeoutSeconds: number;
  dryRun?: boolean;
}): { settings: ClaudeSettings; backup: string | null } {
  const merged = mergeHooks(readSettings(opts.settingsPath), {
    scriptPath: opts.scriptPath ?? defaultHookScriptPath(),
    permissionTimeoutSeconds: opts.permissionTimeoutSeconds,
  });
  const backup = opts.dryRun ? null : writeSettings(opts.settingsPath, merged);
  return { settings: merged, backup };
}

export function uninstallHooks(opts: { settingsPath: string; dryRun?: boolean }): {
  settings: ClaudeSettings;
  backup: string | null;
} {
  if (!existsSync(opts.settingsPath)) return { settings: {}, backup: null };
  const next = removeHooks(readSettings(opts.settingsPath));
  const backup = opts.dryRun ? null : writeSettings(opts.settingsPath, next);
  return { settings: next, backup };
}
