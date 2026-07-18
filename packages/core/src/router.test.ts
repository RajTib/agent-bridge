import { describe, expect, it } from 'vitest';
import { resolveChannel } from './router';
import type { RoutingRule } from './config';

describe('resolveChannel', () => {
  const rules: RoutingRule[] = [
    { agent: 'claude-code', event_type: 'permission_required', channel: 'discord' },
    { agent: 'claude-code', event_type: 'input_required', channel: 'discord' },
    { agent: '*', event_type: 'run_failed', channel: 'discord' },
  ];

  it('matches an exact agent + event_type rule', () => {
    expect(resolveChannel(rules, 'claude-code', 'permission_required')).toBe('discord');
  });

  it('matches a wildcard agent rule', () => {
    expect(resolveChannel(rules, 'codex', 'run_failed')).toBe('discord');
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveChannel(rules, 'codex', 'permission_required')).toBeUndefined();
  });

  it('first matching rule wins', () => {
    const withOverride: RoutingRule[] = [
      { agent: 'claude-code', event_type: 'permission_required', channel: 'telegram' },
      ...rules,
    ];
    expect(resolveChannel(withOverride, 'claude-code', 'permission_required')).toBe('telegram');
  });

  it('a bare wildcard rule ("*"/"*") matches anything', () => {
    const catchAll: RoutingRule[] = [{ agent: '*', event_type: '*', channel: 'discord' }];
    expect(resolveChannel(catchAll, 'anything', 'anything')).toBe('discord');
  });
});
