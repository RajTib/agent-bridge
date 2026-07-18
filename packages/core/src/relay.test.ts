import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@agentbridge/contracts';
import { ApprovalRelay } from './relay';
import type { AuditEntry, AuditLogger } from './audit-log';

class FakeAuditLog implements AuditLogger {
  entries: AuditEntry[] = [];
  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

function makeEvent(): NormalizedEvent {
  return {
    agent: 'claude-code',
    sessionId: 'sess-1',
    eventType: 'permission_required',
    summary: 'Bash: rm -rf ./build',
    fullContext: 'rm -rf ./build',
    riskHint: 'high',
    timestamp: new Date().toISOString(),
  };
}

describe('ApprovalRelay', () => {
  it('resolves to "approved" when decide() is called with approved', async () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 60_000, auditLog });

    const { approval, outcome } = relay.create(makeEvent());
    const decided = relay.decide(approval.id, 'approved', 'raju#0001', 'discord');
    const result = await outcome;

    expect(decided).toBe(true);
    expect(result.decision).toBe('approved');
    expect(result.decidedBy).toBe('raju#0001');
    expect(result.channel).toBe('discord');
    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]?.decision).toBe('approved');
  });

  it('resolves to "denied" with an optional reason', async () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 60_000, auditLog });

    const { approval, outcome } = relay.create(makeEvent());
    relay.decide(approval.id, 'denied', 'raju#0001', 'discord', 'too risky');
    const result = await outcome;

    expect(result.decision).toBe('denied');
    expect(result.reason).toBe('too risky');
  });

  it('times out to "timed_out" if nobody decides in time', async () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 20, auditLog });

    const { outcome } = relay.create(makeEvent());
    const result = await outcome;

    expect(result.decision).toBe('timed_out');
    expect(result.decidedBy).toBeUndefined();
  });

  it('ignores a second decision on an already-resolved approval (no double resolve, no double audit entry)', async () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 60_000, auditLog });

    const { approval, outcome } = relay.create(makeEvent());
    expect(relay.decide(approval.id, 'approved', 'a', 'discord')).toBe(true);
    expect(relay.decide(approval.id, 'denied', 'b', 'discord')).toBe(false);

    const result = await outcome;
    expect(result.decision).toBe('approved'); // first decision wins
    expect(auditLog.entries).toHaveLength(1);
  });

  it('ignores a decision for an unknown approvalId', () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 60_000, auditLog });
    expect(relay.decide('does-not-exist', 'approved', 'a', 'discord')).toBe(false);
  });

  it('removes resolved approvals from the pending count', async () => {
    const auditLog = new FakeAuditLog();
    const relay = new ApprovalRelay({ secret: 's', timeoutMs: 60_000, auditLog });

    const { approval, outcome } = relay.create(makeEvent());
    expect(relay.pendingCount).toBe(1);
    relay.decide(approval.id, 'approved', 'a', 'discord');
    await outcome;
    expect(relay.pendingCount).toBe(0);
  });
});
