import type {
  AgentSession,
  AuditEvent,
  AuditEventType,
  CallResult,
  CallStats,
  CallStatus,
  Decision,
  DecisionStatus,
  PhoneCall,
  ResolutionChannel,
  RiskLevel,
} from '@agentbridge/shared';
import type { Db } from './db.js';

type Row = Record<string, unknown>;

const s = (v: unknown): string => String(v);
const ns = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

function toDecision(r: Row): Decision {
  return {
    id: s(r.id),
    sessionId: s(r.session_id),
    agent: s(r.agent),
    projectName: s(r.project_name),
    cwd: ns(r.cwd),
    toolName: s(r.tool_name),
    summary: s(r.summary),
    spokenSummary: s(r.spoken_summary),
    detail: s(r.detail),
    risk: s(r.risk) as RiskLevel,
    riskReasons: JSON.parse(s(r.risk_reasons)) as string[],
    status: s(r.status) as DecisionStatus,
    createdAt: s(r.created_at),
    expiresAt: s(r.expires_at),
    resolvedAt: ns(r.resolved_at),
    resolvedBy: ns(r.resolved_by),
    resolutionChannel: ns(r.resolution_channel) as ResolutionChannel | null,
    resolutionNote: ns(r.resolution_note),
    lastHeartbeatAt: s(r.last_heartbeat_at),
  };
}

function toSession(r: Row): AgentSession {
  return {
    id: s(r.id),
    agent: s(r.agent),
    projectName: s(r.project_name),
    cwd: ns(r.cwd),
    model: ns(r.model),
    status: s(r.status) as AgentSession['status'],
    startedAt: s(r.started_at),
    lastSeenAt: s(r.last_seen_at),
    endedAt: ns(r.ended_at),
    endReason: ns(r.end_reason),
  };
}

export interface CallRow extends PhoneCall {
  promptSeq: number;
}

function toCall(r: Row): CallRow {
  return {
    id: s(r.id),
    decisionId: s(r.decision_id),
    provider: s(r.provider),
    isRealCall: Number(r.is_real_call) === 1,
    providerCallId: ns(r.provider_call_id),
    toMasked: s(r.to_masked),
    attempt: Number(r.attempt),
    status: s(r.status) as CallStatus,
    result: ns(r.result) as CallResult | null,
    promptSeq: Number(r.prompt_seq),
    promptsPlayed: Number(r.prompts_played),
    invalidInputs: Number(r.invalid_inputs),
    error: ns(r.error),
    createdAt: s(r.created_at),
    answeredAt: ns(r.answered_at),
    endedAt: ns(r.ended_at),
  };
}

function toEvent(r: Row): AuditEvent {
  return {
    id: Number(r.id),
    ts: s(r.ts),
    type: s(r.type) as AuditEventType,
    level: s(r.level) as AuditEvent['level'],
    sessionId: ns(r.session_id),
    decisionId: ns(r.decision_id),
    callId: ns(r.call_id),
    message: s(r.message),
    data: r.data ? (JSON.parse(s(r.data)) as Record<string, unknown>) : null,
  };
}

export interface NewDecisionRow {
  id: string;
  sessionId: string;
  agent: string;
  projectName: string;
  cwd: string | null;
  toolName: string;
  summary: string;
  spokenSummary: string;
  detail: string;
  risk: RiskLevel;
  riskReasons: string[];
  dedupeKey: string;
  createdAt: string;
  expiresAt: string;
}

export interface NewEvent {
  type: AuditEventType;
  level?: AuditEvent['level'];
  sessionId?: string | null;
  decisionId?: string | null;
  callId?: string | null;
  message: string;
  data?: Record<string, unknown> | null;
}

/** Thin, typed data-access layer over SQLite. No business rules live here. */
export class Store {
  constructor(readonly db: Db) {}

  // ---- decisions -------------------------------------------------------

  insertDecision(d: NewDecisionRow): Decision {
    this.db
      .prepare(
        `INSERT INTO decisions (id, session_id, agent, project_name, cwd, tool_name, summary, spoken_summary,
           detail, risk, risk_reasons, dedupe_key, status, created_at, expires_at, last_heartbeat_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(
        d.id,
        d.sessionId,
        d.agent,
        d.projectName,
        d.cwd,
        d.toolName,
        d.summary,
        d.spokenSummary,
        d.detail,
        d.risk,
        JSON.stringify(d.riskReasons),
        d.dedupeKey,
        d.createdAt,
        d.expiresAt,
        d.createdAt,
      );
    return this.getDecision(d.id)!;
  }

  getDecision(id: string): Decision | null {
    const r = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row | undefined;
    return r ? toDecision(r) : null;
  }

  findPendingByDedupeKey(key: string): Decision | null {
    const r = this.db
      .prepare(`SELECT * FROM decisions WHERE dedupe_key = ? AND status = 'pending'`)
      .get(key) as Row | undefined;
    return r ? toDecision(r) : null;
  }

  /**
   * Atomic compare-and-set from `pending` to a terminal status. Returns true
   * only for the single caller that won the transition, which is what makes
   * concurrent phone + dashboard decisions safe ("first decision wins").
   */
  transitionDecision(
    id: string,
    to: Exclude<DecisionStatus, 'pending'>,
    at: string,
    by: string | null,
    channel: ResolutionChannel,
    note: string | null,
    requireUnexpired: boolean,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE decisions
            SET status = ?, resolved_at = ?, resolved_by = ?, resolution_channel = ?, resolution_note = ?
          WHERE id = ? AND status = 'pending' ${requireUnexpired ? 'AND expires_at > ?' : ''}`,
      )
      .run(...([to, at, by, channel, note, id, ...(requireUnexpired ? [at] : [])] as string[]));
    return Number(result.changes) === 1;
  }

  heartbeat(id: string, at: string): void {
    this.db
      .prepare(`UPDATE decisions SET last_heartbeat_at = ? WHERE id = ? AND status = 'pending'`)
      .run(at, id);
  }

  listDecisions(opts: { status?: DecisionStatus; sessionId?: string; limit?: number } = {}): Decision[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.sessionId) {
      where.push('session_id = ?');
      args.push(opts.sessionId);
    }
    const sql = `SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC LIMIT ${Math.min(Math.max(opts.limit ?? 100, 1), 500)}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toDecision);
  }

  pendingExpiredIds(now: string): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM decisions WHERE status = 'pending' AND expires_at <= ?`)
        .all(now) as Row[]
    ).map((r) => s(r.id));
  }

  pendingStaleHeartbeatIds(before: string): string[] {
    return (
      this.db
        .prepare(`SELECT id FROM decisions WHERE status = 'pending' AND last_heartbeat_at < ?`)
        .all(before) as Row[]
    ).map((r) => s(r.id));
  }

  decisionCounts(): Record<DecisionStatus, number> {
    const counts: Record<DecisionStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      cancelled: 0,
    };
    for (const r of this.db
      .prepare('SELECT status, COUNT(*) AS n FROM decisions GROUP BY status')
      .all() as Row[]) {
      counts[s(r.status) as DecisionStatus] = Number(r.n);
    }
    return counts;
  }

  // ---- sessions --------------------------------------------------------

  getSession(id: string): AgentSession | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return r ? toSession(r) : null;
  }

  upsertSession(sess: {
    id: string;
    agent: string;
    projectName: string;
    cwd: string | null;
    model: string | null;
    at: string;
    reactivate: boolean;
  }): AgentSession {
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent, project_name, cwd, model, status, started_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_seen_at = excluded.last_seen_at,
           cwd = COALESCE(excluded.cwd, sessions.cwd),
           project_name = CASE WHEN excluded.cwd IS NOT NULL THEN excluded.project_name ELSE sessions.project_name END,
           model = COALESCE(excluded.model, sessions.model),
           status = CASE WHEN ? THEN 'active' ELSE sessions.status END,
           ended_at = CASE WHEN ? THEN NULL ELSE sessions.ended_at END,
           end_reason = CASE WHEN ? THEN NULL ELSE sessions.end_reason END`,
      )
      .run(
        sess.id,
        sess.agent,
        sess.projectName,
        sess.cwd,
        sess.model,
        sess.at,
        sess.at,
        sess.reactivate ? 1 : 0,
        sess.reactivate ? 1 : 0,
        sess.reactivate ? 1 : 0,
      );
    return this.getSession(sess.id)!;
  }

  endSession(id: string, at: string, reason: string | null): AgentSession | null {
    this.db
      .prepare(
        `UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ?, last_seen_at = ? WHERE id = ?`,
      )
      .run(at, reason, at, id);
    return this.getSession(id);
  }

  listSessions(limit = 50): AgentSession[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM sessions ORDER BY (status = 'active') DESC, last_seen_at DESC LIMIT ?`,
        )
        .all(Math.min(Math.max(limit, 1), 500)) as Row[]
    ).map(toSession);
  }

  activeSessionCount(): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE status = 'active'`).get() as Row;
    return Number(r.n);
  }

  // ---- calls -----------------------------------------------------------

  insertCall(c: {
    id: string;
    decisionId: string;
    provider: string;
    isRealCall: boolean;
    toMasked: string;
    attempt: number;
    status: CallStatus;
    createdAt: string;
  }): CallRow {
    this.db
      .prepare(
        `INSERT INTO calls (id, decision_id, provider, is_real_call, to_masked, attempt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.decisionId, c.provider, c.isRealCall ? 1 : 0, c.toMasked, c.attempt, c.status, c.createdAt);
    return this.getCall(c.id)!;
  }

  getCall(id: string): CallRow | null {
    const r = this.db.prepare('SELECT * FROM calls WHERE id = ?').get(id) as Row | undefined;
    return r ? toCall(r) : null;
  }

  updateCall(
    id: string,
    patch: Partial<{
      providerCallId: string | null;
      status: CallStatus;
      result: CallResult | null;
      promptSeq: number;
      promptsPlayed: number;
      invalidInputs: number;
      error: string | null;
      answeredAt: string | null;
      endedAt: string | null;
    }>,
  ): CallRow | null {
    const map: Record<string, string> = {
      providerCallId: 'provider_call_id',
      status: 'status',
      result: 'result',
      promptSeq: 'prompt_seq',
      promptsPlayed: 'prompts_played',
      invalidInputs: 'invalid_inputs',
      error: 'error',
      answeredAt: 'answered_at',
      endedAt: 'ended_at',
    };
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(v as string | number | null);
    }
    if (sets.length) {
      this.db.prepare(`UPDATE calls SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    return this.getCall(id);
  }

  listCalls(opts: { decisionId?: string; limit?: number } = {}): CallRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.decisionId
      ? this.db
          .prepare('SELECT * FROM calls WHERE decision_id = ? ORDER BY created_at DESC LIMIT ?')
          .all(opts.decisionId, limit)
      : this.db.prepare('SELECT * FROM calls ORDER BY created_at DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toCall);
  }

  callStats(): CallStats {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered,
                SUM(CASE WHEN result = 'approved' THEN 1 ELSE 0 END) AS approved,
                SUM(CASE WHEN result = 'rejected' THEN 1 ELSE 0 END) AS rejected,
                SUM(CASE WHEN result = 'no_response' THEN 1 ELSE 0 END) AS no_response,
                SUM(CASE WHEN status IN ('failed','busy','no_answer') OR result = 'error' THEN 1 ELSE 0 END) AS failed
           FROM calls`,
      )
      .get() as Row;
    return {
      total: Number(r.total ?? 0),
      answered: Number(r.answered ?? 0),
      approved: Number(r.approved ?? 0),
      rejected: Number(r.rejected ?? 0),
      noResponse: Number(r.no_response ?? 0),
      failed: Number(r.failed ?? 0),
    };
  }

  // ---- replay protection ----------------------------------------------

  /** Returns true the first time a key is seen, false on every replay. */
  claimWebhookKey(key: string, at: string): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO processed_webhooks (key, processed_at) VALUES (?, ?)')
      .run(key, at);
    return Number(result.changes) === 1;
  }

  // ---- audit events ----------------------------------------------------

  appendEvent(e: NewEvent, at: string): AuditEvent {
    const result = this.db
      .prepare(
        `INSERT INTO events (ts, type, level, session_id, decision_id, call_id, message, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        e.type,
        e.level ?? 'info',
        e.sessionId ?? null,
        e.decisionId ?? null,
        e.callId ?? null,
        e.message,
        e.data ? JSON.stringify(e.data) : null,
      );
    return toEvent(
      this.db.prepare('SELECT * FROM events WHERE id = ?').get(Number(result.lastInsertRowid)) as Row,
    );
  }

  listEvents(opts: { decisionId?: string; limit?: number; beforeId?: number } = {}): AuditEvent[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.decisionId) {
      where.push('decision_id = ?');
      args.push(opts.decisionId);
    }
    if (opts.beforeId) {
      where.push('id < ?');
      args.push(opts.beforeId);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(toEvent);
  }

  // ---- dashboard sessions ---------------------------------------------

  insertDashboardSession(tokenHash: string, createdAt: string, expiresAt: string, ua: string | null): void {
    this.db
      .prepare(
        'INSERT INTO dashboard_sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)',
      )
      .run(tokenHash, createdAt, expiresAt, ua);
  }

  isDashboardSessionValid(tokenHash: string, now: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM dashboard_sessions WHERE token_hash = ? AND expires_at > ?')
        .get(tokenHash, now),
    );
  }

  deleteDashboardSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM dashboard_sessions WHERE token_hash = ?').run(tokenHash);
  }

  pruneDashboardSessions(now: string): void {
    this.db.prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ?').run(now);
  }
}
