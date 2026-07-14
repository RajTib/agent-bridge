import { describe, expect, it } from 'vitest';
import { renderOutcome } from './deliver';

describe('renderOutcome', () => {
  it('maps approved to permissionDecision allow', () => {
    const result = renderOutcome({
      approvalId: 'a1',
      decision: 'approved',
      decidedBy: 'raju',
      decidedAt: new Date().toISOString(),
      channel: 'discord',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toContain('raju');
  });

  it('maps denied to permissionDecision deny, preferring an explicit reason', () => {
    const result = renderOutcome({
      approvalId: 'a2',
      decision: 'denied',
      decidedAt: new Date().toISOString(),
      reason: 'This touches production credentials.',
    });
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toBe(
      'This touches production credentials.',
    );
  });

  it('falls back to a generic reason when denied has no explicit reason', () => {
    const result = renderOutcome({
      approvalId: 'a2b',
      decision: 'denied',
      decidedAt: new Date().toISOString(),
      decidedBy: 'raju',
    });
    expect(result.json?.hookSpecificOutput.permissionDecisionReason).toContain('Denied');
  });

  it('maps timed_out to permissionDecision ask (safe fallback, never auto-approve)', () => {
    const result = renderOutcome({
      approvalId: 'a3',
      decision: 'timed_out',
      decidedAt: new Date().toISOString(),
    });
    expect(result.json?.hookSpecificOutput.permissionDecision).toBe('ask');
  });
});
