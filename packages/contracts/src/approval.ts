import { NormalizedEvent } from './events';

export type Decision = 'approved' | 'denied' | 'timed_out';

/**
 * A single approval waiting on a human decision. `token` is signed,
 * single-use, and expiring — see docs/security.md for why this replaces a
 * shared-secret topic name.
 */
export interface PendingApproval {
  /** Opaque approval id, not a guessable topic/secret. */
  id: string;

  token: string;

  /** ISO 8601. Past this, the token is rejected regardless of signature validity. */
  expiresAt: string;

  event: NormalizedEvent;
}

export interface ApprovalOutcome {
  approvalId: string;

  decision: Decision;

  /** Identity of the human who decided, e.g. a Discord user tag. Absent for timed_out. */
  decidedBy?: string;

  decidedAt: string;

  /** Which channel the decision came from, e.g. "discord". */
  channel?: string;

  /** Optional human-provided reason, mainly for "denied". */
  reason?: string;
}
