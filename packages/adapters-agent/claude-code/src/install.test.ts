import { describe, expect, it } from 'vitest';
import { mergeHooksIntoSettings } from './install';

describe('mergeHooksIntoSettings', () => {
  it('adds hooks to empty settings', () => {
    const result = mergeHooksIntoSettings({});
    expect(result.hooks?.PreToolUse).toHaveLength(1);
    expect(result.hooks?.Notification).toHaveLength(1);
    expect(result.hooks?.Stop).toHaveLength(1);
  });

  it('preserves unrelated existing hooks', () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command' as const, command: 'my-other-tool --check' }] },
        ],
      },
    };
    const result = mergeHooksIntoSettings(existing);
    const commands = (result.hooks!.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('my-other-tool --check');
    expect(commands.some((c) => c.includes('agentbridge'))).toBe(true);
  });

  it('preserves unrelated top-level settings keys', () => {
    const existing = { someOtherSetting: 'keep-me' };
    const result = mergeHooksIntoSettings(existing);
    expect(result.someOtherSetting).toBe('keep-me');
  });

  it('is idempotent — running twice does not duplicate our hook', () => {
    const once = mergeHooksIntoSettings({});
    const twice = mergeHooksIntoSettings(once);
    expect(twice.hooks!.PreToolUse).toHaveLength(1);
    expect(twice.hooks!.Notification).toHaveLength(1);
    expect(twice.hooks!.Stop).toHaveLength(1);
  });

  it('only puts a matcher on PreToolUse, not on Notification or Stop', () => {
    const result = mergeHooksIntoSettings({});
    expect(result.hooks?.PreToolUse?.[0]?.matcher).toBe('*');
    expect(result.hooks?.Notification?.[0]?.matcher).toBeUndefined();
    expect(result.hooks?.Stop?.[0]?.matcher).toBeUndefined();
  });
});
