import type { Decision, DecisionStatus, ResolutionChannel } from '@agentbridge/shared';
import { isTerminalStatus } from '@agentbridge/shared';
import type { Audit, EventBus } from './bus.js';
import { describeAction } from './describe.js';
import { newId, sha256, stableStringify } from './ids.js';
import { assessRisk } from './risk.js';
import { projectNameFromCwd, type SessionService } from './sessions.js';
import type { Store } from './store.js';

export interface PermissionRequestInput {
  sessionId: string;
  agent: string;
  cwd: string | null;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface CreateResult {
  decision: Decision;
  /** True when an identical pending decision already existed and was reused. */
  duplicate: boolean;
}

export type ResolveFailure = 'not_found' | 'already_resolved' | 'expired';

export type ResolveResult =
  | { ok: true; decision: Decision }
  | { ok: false; reason: ResolveFailure; decision: Decision | null };

export interface ResolveContext {
  channel: ResolutionChannel;
  by: string;
  note?: string | null;
  callId?: string | null;
}

export interface DecisionServiceOptions {
  store: Store;
  bus: EventBus;
  audit: Audit;
  sessions: SessionService;
  timeoutSeconds: number;
  heartbeatGraceSeconds: number;
  now?: () => Date;
}

/**
 * The approval state machine. A decision is created `pending` and moves
 * exactly once to a terminal state:
 *
 *   pending ──approve──▶ approved   (the ONLY state that lets an action run)
 *           ──reject───▶ rejected
 *           ──timeout──▶ expired
 *           ──cancel───▶ cancelled  (agent stopped waiting / session ended)
 *
 * Transitions are compare-and-set in SQLite, so phone, dashboard and the
 * expiry sweeper can race safely: whoever commits first wins and everyone
 * else is told the decision is already resolved.
 */
export class DecisionService {
  private readonly waiters = new Map<string, Set<(d: Decision) => void>>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly o: DecisionServiceOptions) {
    this.now = o.now ?? (() => new Date());
  }

  start(intervalMs = 1000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    // Release any long-polls so the process can exit; callers re-read state.
    for (const [id, set] of this.waiters) {
      const d = this.o.store.getDecision(id);
      if (d) for (const w of set) w(d);
    }
    this.waiters.clear();
  }

  static dedupeKey(input: PermissionRequestInput): string {
    return sha256(
      [input.agent, input.sessionId, input.toolName, stableStringify(input.toolInput)].join('\u0000'),
    );
  }

  create(input: PermissionRequestInput): CreateResult {
    const nowIso = this.now().toISOString();
    const key = DecisionService.dedupeKey(input);

    const existing = this.o.store.findPendingByDedupeKey(key);
    if (existing) {
      if (existing.expiresAt > nowIso) {
        this.o.store.heartbeat(existing.id, nowIso);
        this.o.audit.record({
          type: 'decision.duplicate',
          sessionId: existing.sessionId,
          decisionId: existing.id,
          message: 'Duplicate permission request matched an existing pending decision',
        });
        return { decision: this.o.store.getDecision(existing.id)!, duplicate: true };
      }
      this.expire(existing.id);
    }

    this.o.sessions.touch({ sessionId: input.sessionId, agent: input.agent, cwd: input.cwd });

    const risk = assessRisk(input.toolName, input.toolInput);
    const description = describeAction(input.toolName, input.toolInput);
    const expiresAt = new Date(this.now().getTime() + this.o.timeoutSeconds * 1000).toISOString();

    const decision = this.o.store.insertDecision({
      id: newId('dec'),
      sessionId: input.sessionId,
      agent: input.agent,
      projectName: projectNameFromCwd(input.cwd),
      cwd: input.cwd,
      toolName: input.toolName,
      summary: description.summary,
      spokenSummary: description.spoken,
      detail: description.detail,
      risk: risk.level,
      riskReasons: risk.reasons,
      dedupeKey: key,
      createdAt: nowIso,
      expiresAt,
    });

    this.o.audit.record({
      type: 'decision.created',
      sessionId: decision.sessionId,
      decisionId: decision.id,
      message: `Approval required: ${decision.summary}`,
      data: { tool: decision.toolName, risk: decision.risk, expiresAt },
    });
    this.o.bus.emit('decision.created', decision);
    this.o.bus.emit('decision.updated', decision);
    return { decision, duplicate: false };
  }

  get(id: string): Decision | null {
    return this.o.store.getDecision(id);
  }

  list(opts: { status?: DecisionStatus; sessionId?: string; limit?: number } = {}): Decision[] {
    return this.o.store.listDecisions(opts);
  }

  /** Human decision (phone or dashboard). Never succeeds on an expired or settled decision. */
  resolve(id: string, outcome: 'approved' | 'rejected', ctx: ResolveContext): ResolveResult {
    const current = this.o.store.getDecision(id);
    if (!current) return this.refuse(id, 'not_found', null, ctx);
    if (current.status !== 'pending') return this.refuse(id, 'already_resolved', current, ctx);

    const nowIso = this.now().toISOString();
    if (current.expiresAt <= nowIso) {
      this.expire(id);
      return this.refuse(id, 'expired', this.o.store.getDecision(id), ctx);
    }

    const won = this.o.store.transitionDecision(
      id,
      outcome,
      nowIso,
      ctx.by,
      ctx.channel,
      ctx.note ?? null,
      true,
    );
    if (!won) {
      const latest = this.o.store.getDecision(id);
      return this.refuse(
        id,
        latest && latest.status === 'pending' ? 'expired' : 'already_resolved',
        latest,
        ctx,
      );
    }

    const decision = this.o.store.getDecision(id)!;
    this.o.audit.record({
      type: outcome === 'approved' ? 'decision.approved' : 'decision.rejected',
      sessionId: decision.sessionId,
      decisionId: id,
      callId: ctx.callId ?? null,
      message: `${outcome === 'approved' ? 'Approved' : 'Rejected'} via ${ctx.channel} by ${ctx.by}: ${decision.summary}`,
      data: { channel: ctx.channel, by: ctx.by },
    });
    this.settled(decision);
    return { ok: true, decision };
  }

  /** The agent is no longer waiting (hook disconnected, session ended, superseded). */
  cancel(id: string, note: string): Decision | null {
    const won = this.o.store.transitionDecision(
      id,
      'cancelled',
      this.now().toISOString(),
      'system',
      'system',
      note,
      false,
    );
    if (!won) return null;
    const decision = this.o.store.getDecision(id)!;
    this.o.audit.record({
      type: 'decision.cancelled',
      level: 'warn',
      sessionId: decision.sessionId,
      decisionId: id,
      message: `Cancelled: ${note}`,
    });
    this.settled(decision);
    return decision;
  }

  expire(id: string): Decision | null {
    const won = this.o.store.transitionDecision(
      id,
      'expired',
      this.now().toISOString(),
      'system',
      'system',
      'No decision before the approval timeout. The action was NOT approved.',
      false,
    );
    if (!won) return null;
    const decision = this.o.store.getDecision(id)!;
    this.o.audit.record({
      type: 'decision.expired',
      level: 'warn',
      sessionId: decision.sessionId,
      decisionId: id,
      message: `Expired without a decision (not approved): ${decision.summary}`,
    });
    this.settled(decision);
    return decision;
  }

  cancelPendingForSession(sessionId: string, note: string): number {
    let n = 0;
    for (const d of this.o.store.listDecisions({ sessionId, status: 'pending', limit: 500 })) {
      if (this.cancel(d.id, note)) n++;
    }
    return n;
  }

  heartbeat(id: string): void {
    this.o.store.heartbeat(id, this.now().toISOString());
  }

  /**
   * Long-poll helper: resolves with the decision as soon as it is terminal,
   * or with its current (pending) state after `timeoutMs`. Each call counts
   * as a heartbeat from the waiting hook process.
   */
  wait(id: string, timeoutMs: number): Promise<Decision | null> {
    const current = this.o.store.getDecision(id);
    if (!current || isTerminalStatus(current.status)) return Promise.resolve(current);
    this.heartbeat(id);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) {
        set = new Set();
        this.waiters.set(id, set);
      }
      const done = (d: Decision) => {
        clearTimeout(timer);
        set!.delete(done);
        if (set!.size === 0) this.waiters.delete(id);
        resolve(d);
      };
      const timer = setTimeout(() => {
        set!.delete(done);
        if (set!.size === 0) this.waiters.delete(id);
        resolve(this.o.store.getDecision(id));
      }, timeoutMs);
      timer.unref();
      set.add(done);
    });
  }

  /** Expires overdue decisions and cancels ones whose hook stopped polling. */
  sweep(): void {
    const now = this.now();
    for (const id of this.o.store.pendingExpiredIds(now.toISOString())) this.expire(id);
    const staleBefore = new Date(now.getTime() - this.o.heartbeatGraceSeconds * 1000).toISOString();
    for (const id of this.o.store.pendingStaleHeartbeatIds(staleBefore)) {
      this.cancel(id, 'Claude Code stopped waiting for this decision (hook disconnected).');
    }
  }

  private settled(decision: Decision): void {
    this.o.bus.emit('decision.updated', decision);
    this.o.bus.emit('decision.resolved', decision);
    const set = this.waiters.get(decision.id);
    if (set) for (const w of [...set]) w(decision);
  }

  private refuse(
    id: string,
    reason: ResolveFailure,
    decision: Decision | null,
    ctx: ResolveContext,
  ): ResolveResult {
    this.o.audit.record({
      type: 'decision.resolve_refused',
      level: 'warn',
      sessionId: decision?.sessionId ?? null,
      decisionId: decision ? id : null,
      callId: ctx.callId ?? null,
      message: `Refused ${ctx.channel} decision: ${reason}`,
      data: { reason, channel: ctx.channel, status: decision?.status ?? null },
    });
    return { ok: false, reason, decision };
  }
}
