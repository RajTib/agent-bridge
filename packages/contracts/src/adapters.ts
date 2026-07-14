import { NormalizedEvent } from './events';
import { ApprovalOutcome, Decision, PendingApproval } from './approval';

/**
 * Translates one AI coding agent's native event format into a NormalizedEvent,
 * and translates a decided ApprovalOutcome back into whatever that agent
 * expects in order to resume or block execution (exit code, stdout JSON, a
 * decision file — whatever the underlying tool's hook contract requires).
 *
 * An AgentAdapter never talks to a channel directly; it only talks to the
 * core relay.
 */
export interface AgentAdapter {
  /** Stable identifier, e.g. "claude-code". Must match config `agent:` values. */
  readonly name: string;

  normalize(rawPayload: unknown): NormalizedEvent;

  deliverOutcome(outcome: ApprovalOutcome): Promise<void> | void;
}

/**
 * Pure send/receive to a human-facing channel. Given a pending approval,
 * render and deliver it with the FULL context (see docs/security.md,
 * GhostApproval). Given a human action, report it back via the callback the
 * core relay registers.
 *
 * A ChannelAdapter never touches the filesystem and never resolves an
 * approval itself — only the core relay's state machine does that.
 */
export interface ChannelAdapter {
  /** Stable identifier, e.g. "discord". Must match config `channel:` values. */
  readonly name: string;

  send(approval: PendingApproval): Promise<void>;

  onDecision(
    handler: (
      approvalId: string,
      decision: Decision,
      decidedBy: string,
      reason?: string,
    ) => Promise<void>,
  ): void;
}
