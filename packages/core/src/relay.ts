import { randomUUID } from 'node:crypto';
import type {
  ApprovalOutcome,
  Decision,
  NormalizedEvent,
  PendingApproval,
} from '@agentbridge/contracts';
import { issueToken } from './tokens';
import type { AuditLogger } from './audit-log';

interface PendingRecord {
  approval: PendingApproval;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  timer: NodeJS.Timeout;
  settle: (outcome: ApprovalOutcome) => void;
}

export interface ApprovalRelayOptions {
  secret: string;
  timeoutMs: number;
  auditLog: AuditLogger;
}

/**
 * Owns the approval lifecycle end to end: pending -> approved / denied /
 * timed_out. This is the ONLY place allowed to decide an approval is final
 * -- channel adapters only ever report a human's click here, they never
 * resolve anything themselves (see docs/architecture.md).
 */
export class ApprovalRelay {
  private readonly pending = new Map<string, PendingRecord>();

  constructor(private readonly options: ApprovalRelayOptions) {}

  /** Creates a pending approval and schedules its safe timeout fallback. */
  create(event: NormalizedEvent): { approval: PendingApproval; outcome: Promise<ApprovalOutcome> } {
    const id = randomUUID();
    const { token, expiresAt } = issueToken(id, this.options.timeoutMs, this.options.secret);
    const approval: PendingApproval = { id, token, expiresAt, event };

    const outcome = new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(id, 'timed_out');
      }, this.options.timeoutMs);
      timer.unref();

      this.pending.set(id, {
        approval,
        status: 'pending',
        timer,
        settle: resolve,
      });
    });

    return { approval, outcome };
  }

  /**
   * Called when a human clicks Approve/Deny in a channel adapter. Returns
   * false if the approval doesn't exist or was already resolved -- e.g. a
   * double-click, or a decision arriving after the safe timeout already
   * fired. A channel adapter should treat `false` as "nothing to do," not
   * as an error to surface to the human.
   */
  decide(
    approvalId: string,
    decision: Extract<Decision, 'approved' | 'denied'>,
    decidedBy: string,
    channel: string,
    reason?: string,
  ): boolean {
    return this.settle(approvalId, decision, decidedBy, channel, reason);
  }

  private settle(
    approvalId: string,
    decision: Decision,
    decidedBy?: string,
    channel?: string,
    reason?: string,
  ): boolean {
    const record = this.pending.get(approvalId);
    if (!record || record.status !== 'pending') return false;

    clearTimeout(record.timer);
    record.status = decision;
    this.pending.delete(approvalId);

    const decidedAt = new Date().toISOString();
    const outcome: ApprovalOutcome = { approvalId, decision, decidedBy, decidedAt, channel, reason };

    this.options.auditLog.record({
      timestamp: decidedAt,
      approvalId,
      agent: record.approval.event.agent,
      sessionId: record.approval.event.sessionId,
      eventType: record.approval.event.eventType,
      summary: record.approval.event.summary,
      riskHint: record.approval.event.riskHint,
      decision,
      decidedBy,
      channel,
      reason,
    });

    record.settle(outcome);
    return true;
  }

  /** Exposed for tests and for the daemon's graceful-shutdown path. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
