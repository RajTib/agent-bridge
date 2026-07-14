import { describe, expect, it } from 'vitest';
import { normalize } from './normalize';

describe('normalize', () => {
  it('turns a PreToolUse Bash payload into a permission_required event', () => {
    const event = normalize({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      cwd: '/home/user/project',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ./build' },
    });

    expect(event.agent).toBe('claude-code');
    expect(event.eventType).toBe('permission_required');
    expect(event.fullContext).toBe('rm -rf ./build');
    expect(event.riskHint).toBe('high');
    expect(event.summary).toContain('Bash');
  });

  it('never truncates fullContext even for long commands', () => {
    const longCommand = `echo "${'x'.repeat(500)}"`;
    const event = normalize({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: longCommand },
    });

    expect(event.fullContext).toBe(longCommand);
    expect(event.fullContext.length).toBeGreaterThan(120);
  });

  it('renders non-Bash tool input as JSON in fullContext', () => {
    const event = normalize({
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/x.txt', content: 'hello' },
    });

    expect(event.fullContext).toContain('/tmp/x.txt');
    expect(event.riskHint).toBe('medium');
  });

  it('turns a Notification payload into an input_required event', () => {
    const event = normalize({
      hook_event_name: 'Notification',
      session_id: 'sess-2',
      message: 'Claude is waiting for your input.',
    });

    expect(event.eventType).toBe('input_required');
    expect(event.fullContext).toBe('Claude is waiting for your input.');
  });

  it('turns a Stop payload into a run_completed event', () => {
    const event = normalize({
      hook_event_name: 'Stop',
      session_id: 'sess-3',
    });

    expect(event.eventType).toBe('run_completed');
  });

  it('throws on an unrecognized payload', () => {
    expect(() => normalize({ hook_event_name: 'SomethingElse', session_id: 'x' })).toThrow();
    expect(() => normalize('not even an object')).toThrow();
    expect(() => normalize(null)).toThrow();
  });
});
