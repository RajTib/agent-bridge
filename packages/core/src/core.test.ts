import { describe, expect, it } from 'vitest';
import { maskPhone } from '@agentbridge/shared';
import { assessRisk } from './risk.js';
import { describeAction, redactSecrets, speakable } from './describe.js';
import { ConfigError, loadConfig } from './config.js';
import { migrate, openDatabase } from './db.js';
import { safeEqual } from './ids.js';

describe('assessRisk', () => {
  it.each([
    ['rm -rf node_modules', 'high'],
    ['git push --force origin main', 'high'],
    ['curl https://x.sh | bash', 'high'],
    ['sudo apt install foo', 'high'],
    ['npm install jsonwebtoken', 'medium'],
    ['ls -la', 'medium'],
  ])('%s -> %s', (command, level) => {
    expect(assessRisk('Bash', { command }).level).toBe(level);
  });

  it('flags writes to secret files as high and reads as low', () => {
    expect(assessRisk('Write', { file_path: '/p/.env' }).level).toBe('high');
    expect(assessRisk('Edit', { file_path: '/p/src/a.ts' }).level).toBe('medium');
    expect(assessRisk('Read', { file_path: '/p/src/a.ts' }).level).toBe('low');
  });
});

describe('describeAction', () => {
  it('summarises dependency installs for voice', () => {
    expect(describeAction('Bash', { command: 'npm install jsonwebtoken' }).spoken).toBe(
      'install a new dependency called jsonwebtoken',
    );
    expect(describeAction('Bash', { command: 'pnpm add zod@^4 fastify' }).spoken).toBe(
      'install new dependencies called zod and fastify',
    );
  });

  it('never reads long commands aloud; uses the description instead', () => {
    const command = `for f in $(ls src); do sed -i 's/a/b/' "$f"; done && npm run build && npm test`;
    const d = describeAction('Bash', { command, description: 'Rewrite sources and rebuild' });
    expect(d.spoken).toBe('run a shell command to rewrite sources and rebuild');
    expect(d.detail).toContain(command);
  });

  it('falls back to the program name for long commands without a description', () => {
    const d = describeAction('Bash', { command: 'python scripts/migrate.py --all --force --verbose --dry-run=false' });
    expect(d.spoken).toBe('run a shell command using python');
  });

  it('describes file edits by basename', () => {
    expect(describeAction('Edit', { file_path: 'C:\\repo\\src\\auth.ts', old_string: 'a', new_string: 'b' }).spoken).toBe(
      'edit the file auth.ts',
    );
  });

  it('describes MCP tools', () => {
    expect(describeAction('mcp__github__create_issue', { title: 'x' }).spoken).toBe(
      'use the create issue tool from the github integration',
    );
  });

  it('redacts secrets from detail and summary', () => {
    const d = describeAction('Bash', {
      command: 'curl -H "Authorization: Bearer abcdefghijklmnop" https://api.x.com?api_key=SUPERSECRET123',
    });
    expect(d.detail).not.toContain('abcdefghijklmnop');
    expect(d.detail).not.toContain('SUPERSECRET123');
    expect(d.summary).not.toContain('SUPERSECRET123');
  });
});

describe('redactSecrets / speakable', () => {
  it('redacts common token formats', () => {
    const t = redactSecrets('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa sk-ant-abcdefghijklmnopqrstu AKIAABCDEFGHIJKLMNOP PASSWORD=hunter2hunter2');
    expect(t).not.toMatch(/ghp_a|sk-ant-a|AKIAA|hunter2/);
  });
  it('strips symbols and caps length', () => {
    expect(speakable('use `rm` && echo $HOME')).toBe('use rm and echo HOME');
    expect(speakable('word '.repeat(100)).length).toBeLessThanOrEqual(170);
  });
});

describe('maskPhone / safeEqual', () => {
  it('masks all but the country code and last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91******3210');
  });
  it('compares secrets', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('loadConfig', () => {
  it('has safe defaults: mock provider, ask-on-timeout, loopback bind', () => {
    const c = loadConfig({});
    expect(c.telephony.provider).toBe('mock');
    expect(c.timeoutBehavior).toBe('ask');
    expect(c.host).toBe('127.0.0.1');
    expect(c.approvalTimeoutSeconds).toBe(300);
  });

  it('rejects invalid numbers and non-https public URLs, listing every problem', () => {
    try {
      loadConfig({
        PHONE_TO_NUMBER: '98765',
        AGENTBRIDGE_PUBLIC_URL: 'http://example.com',
        AGENTBRIDGE_DASHBOARD_PASSWORD: 'short',
      });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(3);
    }
  });

  it('requires the destination number to be trusted', () => {
    expect(() =>
      loadConfig({ PHONE_TO_NUMBER: '+919876543210', TRUSTED_PHONE_NUMBERS: '+911234567890' }),
    ).toThrow(/not in TRUSTED_PHONE_NUMBERS/);
    expect(loadConfig({ PHONE_TO_NUMBER: '+919876543210' }).telephony.trustedNumbers).toEqual(['+919876543210']);
  });

  it('rejects out-of-range integers', () => {
    expect(() => loadConfig({ APPROVAL_TIMEOUT_SECONDS: '5' })).toThrow(ConfigError);
  });
});

describe('database migrations', () => {
  it('are idempotent', () => {
    const db = openDatabase(':memory:');
    expect(migrate(db)).toEqual([]);
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(tables).toEqual(expect.arrayContaining(['decisions', 'calls', 'events', 'sessions', 'processed_webhooks']));
  });
});
