import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApprovalOutcome, NormalizedEvent } from '@agentbridge/contracts';

export interface AuditEntry {
  timestamp: string;
  /** Absent for non-approval events (Notification/Stop) -- there's no pending approval to reference. */
  approvalId?: string;
  agent: string;
  sessionId: string;
  eventType: NormalizedEvent['eventType'];
  summary: string;
  riskHint: NormalizedEvent['riskHint'];
  /** Absent for non-approval events. */
  decision?: ApprovalOutcome['decision'];
  decidedBy?: string;
  channel?: string;
  reason?: string;
}

/** The relay depends on this interface, not the concrete class below -- makes it trivial to fake in tests. */
export interface AuditLogger {
  record(entry: AuditEntry): void;
}

/**
 * Structured, append-only, one-JSON-object-per-line audit log of every
 * decision. Deliberately logs `summary`, not `fullContext` -- a durable log
 * of every raw command/diff this tool has ever seen would be a bigger
 * standing risk than the audit trail is worth. See docs/security.md.
 */
export class AuditLog implements AuditLogger {
  constructor(private readonly path: string) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  record(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf-8');
  }
}
