import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpretDecisionResponse, renderPermissionOutput } from './output.js';
import { installHooks, mergeHooks, removeHooks, uninstallHooks, type ClaudeSettings } from './install.js';
import { runPermissionRequest } from './hook.js';

describe('renderPermissionOutput', () => {
  it('allows only on an explicit approval, with no updatedInput/updatedPermissions', () => {
    const out = renderPermissionOutput({ kind: 'approved', decisionId: 'dec_1', via: 'phone' }, 'ask');
    expect(out).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  it('denies on rejection with a message for Claude', () => {
    const out = renderPermissionOutput(
      { kind: 'rejected', decisionId: 'dec_1', via: 'phone', note: null },
      'ask',
    );
    expect(out?.hookSpecificOutput.decision.behavior).toBe('deny');
    expect(JSON.stringify(out)).toContain('rejected this action');
  });

  it('never allows when unresolved: no output (normal prompt) or explicit deny', () => {
    expect(renderPermissionOutput({ kind: 'unresolved', reason: 'approval timed out' }, 'ask')).toBeNull();
    const deny = renderPermissionOutput({ kind: 'unresolved', reason: 'approval timed out' }, 'deny');
    expect(deny?.hookSpecificOutput.decision.behavior).toBe('deny');
  });
});

describe('interpretDecisionResponse (fail closed)', () => {
  it('ignores approvals for a different decision id', () => {
    expect(interpretDecisionResponse('dec_A', { decisionId: 'dec_B', status: 'approved' })).toEqual({
      kind: 'unresolved',
      reason: 'decision id mismatch',
    });
  });
  it.each([null, 'approved', 42, { status: 'approved' }])('treats %j as not approved', (body) => {
    expect(interpretDecisionResponse('dec_A', body)?.kind).toBe('unresolved');
  });
  it('keeps waiting on pending; maps expired/cancelled/unknown to unresolved', () => {
    expect(interpretDecisionResponse('d', { decisionId: 'd', status: 'pending' })).toBeNull();
    for (const status of ['expired', 'cancelled', 'APPROVED', 'allow']) {
      expect(interpretDecisionResponse('d', { decisionId: 'd', status })?.kind).toBe('unresolved');
    }
  });
});

describe('runPermissionRequest when the server is unavailable', () => {
  it('fails closed without a token', async () => {
    const run = await runPermissionRequest(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { baseUrl: 'http://127.0.0.1:9', token: null, fallbackTimeoutBehavior: 'ask' },
      { log: () => {} },
    );
    expect(run.outcome.kind).toBe('unresolved');
  });

  it('fails closed when nothing is listening', async () => {
    const run = await runPermissionRequest(
      { session_id: 's', tool_name: 'Bash', tool_input: { command: 'ls' } },
      { baseUrl: 'http://127.0.0.1:9', token: 'x'.repeat(32), fallbackTimeoutBehavior: 'deny' },
      { log: () => {} },
    );
    expect(run.outcome).toEqual({ kind: 'unresolved', reason: 'AgentBridge server unreachable' });
    expect(renderPermissionOutput(run.outcome, run.timeoutBehavior)?.hookSpecificOutput.decision.behavior).toBe(
      'deny',
    );
  });
});

describe('hook installer', () => {
  const opts = { scriptPath: 'C:\\ab\\packages\\claude-code\\dist\\hook.js', permissionTimeoutSeconds: 330 };
  const existing: ClaudeSettings = {
    model: 'opus',
    permissions: { allow: ['Bash(npm test)'] },
    hooks: {
      PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'agentbridge hook pre-tool-use' }] }],
    },
  };

  it('adds our hooks, keeps unrelated settings and third-party hooks, removes v0 entries', () => {
    const merged = mergeHooks(existing, opts);
    expect(merged.model).toBe('opus');
    expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(merged.hooks!.PermissionRequest).toHaveLength(2);
    expect(merged.hooks!.PermissionRequest![0]!.hooks[0]!.command).toBe('my-own-hook.sh');
    const ours = merged.hooks!.PermissionRequest![1]!;
    expect(ours.matcher).toBe('*');
    expect(ours.hooks[0]).toEqual({
      type: 'command',
      command: 'node "C:/ab/packages/claude-code/dist/hook.js" PermissionRequest --agentbridge',
      timeout: 330,
    });
    expect(merged.hooks!.PreToolUse).toBeUndefined();
    for (const e of ['SessionStart', 'SessionEnd', 'Notification', 'Stop', 'StopFailure']) {
      expect(merged.hooks![e]).toHaveLength(1);
    }
  });

  it('is idempotent', () => {
    const once = mergeHooks(existing, opts);
    expect(mergeHooks(once, opts)).toEqual(once);
  });

  it('removes only its own entries', () => {
    const cleaned = removeHooks(mergeHooks(existing, opts));
    expect(cleaned.hooks).toEqual({
      PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] }],
    });
  });

  it('writes a backup and round-trips through the file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-install-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, JSON.stringify(existing));
    const { backup } = installHooks({ settingsPath: path, scriptPath: opts.scriptPath, permissionTimeoutSeconds: 330 });
    expect(backup).toBeTruthy();
    expect(JSON.parse(readFileSync(backup!, 'utf8'))).toEqual(existing);
    const installed = JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings;
    expect(Object.keys(installed.hooks!)).toContain('StopFailure');
    uninstallHooks({ settingsPath: path });
    const after = JSON.parse(readFileSync(path, 'utf8')) as ClaudeSettings;
    expect(after.hooks!.PermissionRequest).toHaveLength(1);
  });

  it('refuses to modify a settings file that is not a JSON object', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-install-'));
    const path = join(dir, 'settings.json');
    writeFileSync(path, '[1,2,3]');
    expect(() => installHooks({ settingsPath: path, permissionTimeoutSeconds: 330 })).toThrow(/refusing/);
  });
});
