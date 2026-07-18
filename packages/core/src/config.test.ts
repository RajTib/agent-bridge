import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expandHome, loadConfig } from './config';

describe('loadConfig', () => {
  it('returns sane defaults when no config file exists', () => {
    const config = loadConfig(join(tmpdir(), 'definitely-does-not-exist.yml'));
    expect(config.routing).toEqual([{ agent: '*', event_type: 'permission_required', channel: 'discord' }]);
    expect(config.timeout.seconds).toBe(300);
    expect(config.channels.discord?.bot_token_env).toBe('DISCORD_BOT_TOKEN');
  });

  it('loads and merges a real YAML file over the defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentbridge-config-'));
    const path = join(dir, 'agentbridge.yml');
    writeFileSync(
      path,
      [
        'routing:',
        '  - agent: "*"',
        '    event_type: "*"',
        '    channel: telegram',
        'timeout:',
        '  seconds: 60',
      ].join('\n'),
      'utf-8',
    );

    const config = loadConfig(path);
    expect(config.routing).toEqual([{ agent: '*', event_type: '*', channel: 'telegram' }]);
    expect(config.timeout.seconds).toBe(60);
    expect(config.timeout.fallback).toBe('terminal_prompt'); // untouched default preserved
  });
});

describe('expandHome', () => {
  it('leaves absolute paths untouched', () => {
    expect(expandHome('/var/log/agentbridge.log')).toBe('/var/log/agentbridge.log');
  });

  it('expands a leading ~', () => {
    const expanded = expandHome('~/agentbridge.log');
    expect(expanded).not.toContain('~');
    expect(expanded.endsWith('/agentbridge.log') || expanded.endsWith('\\agentbridge.log')).toBe(true);
  });
});
