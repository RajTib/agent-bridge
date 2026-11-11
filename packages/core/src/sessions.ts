import type { AgentSession } from '@agentbridge/shared';
import type { Audit, EventBus } from './bus.js';
import type { Store } from './store.js';

export function projectNameFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return 'unknown project';
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

export interface SessionTouch {
  sessionId: string;
  agent: string;
  cwd: string | null;
  model?: string | null;
}

/** Tracks agent sessions (one per Claude Code session_id). */
export class SessionService {
  constructor(
    private readonly store: Store,
    private readonly bus: EventBus,
    private readonly audit: Audit,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Records activity for a session, creating it on first sight. */
  touch(t: SessionTouch, opts: { reactivate?: boolean } = {}): AgentSession {
    const before = this.store.getSession(t.sessionId);
    const session = this.store.upsertSession({
      id: t.sessionId,
      agent: t.agent,
      projectName: projectNameFromCwd(t.cwd),
      cwd: t.cwd,
      model: t.model ?? null,
      at: this.now().toISOString(),
      reactivate: opts.reactivate ?? !before,
    });
    if (!before) {
      this.audit.record({
        type: 'session.started',
        sessionId: session.id,
        message: `${session.agent} session started in ${session.projectName}`,
        data: { cwd: session.cwd, model: session.model },
      });
    }
    this.bus.emit('session', session);
    return session;
  }

  /** SessionStart hook: (re)activates the session. */
  start(t: SessionTouch, source: string | null): AgentSession {
    const before = this.store.getSession(t.sessionId);
    const session = this.touch(t, { reactivate: true });
    if (before) {
      this.audit.record({
        type: 'session.started',
        sessionId: session.id,
        message: `${session.agent} session ${source ?? 'resumed'} in ${session.projectName}`,
        data: { source },
      });
    }
    return session;
  }

  end(sessionId: string, reason: string | null): AgentSession | null {
    const session = this.store.endSession(sessionId, this.now().toISOString(), reason);
    if (!session) return null;
    this.audit.record({
      type: 'session.ended',
      sessionId,
      message: `${session.agent} session in ${session.projectName} ended${reason ? ` (${reason})` : ''}`,
      data: { reason },
    });
    this.bus.emit('session', session);
    return session;
  }

  get(id: string): AgentSession | null {
    return this.store.getSession(id);
  }

  list(limit?: number): AgentSession[] {
    return this.store.listSessions(limit);
  }
}
