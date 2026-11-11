import type { AgentSession } from '@agentbridge/shared';
import { formatFull, formatTime } from '../time';
import { CopyId, Empty, RelTime, Section } from './common';

export function SessionsList({ sessions, now }: { sessions: AgentSession[]; now: number }) {
  const active = sessions.filter((s) => s.status === 'active').length;
  return (
    <Section title="Sessions" id="sessions" count={active}>
      {sessions.length === 0 ? (
        <Empty>No agent sessions seen yet.</Empty>
      ) : (
        <ul className="session-list">
          {sessions.map((s) => (
            <li key={s.id} className={`session session-${s.status}`}>
              <div className="session-top">
                <span className="session-project">{s.projectName}</span>
                <span className={`chip session-chip-${s.status}`}>{s.status}</span>
              </div>
              <dl className="kv kv-inline">
                <div>
                  <dt>Agent</dt>
                  <dd>{s.agent}</dd>
                </div>
                <div>
                  <dt>Session</dt>
                  <dd>
                    <CopyId id={s.id} label="Session ID" />
                  </dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd className="mono">{s.model ?? '—'}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd title={formatFull(s.startedAt)}>{formatTime(s.startedAt)}</dd>
                </div>
                <div>
                  <dt>Last seen</dt>
                  <dd>
                    <RelTime iso={s.lastSeenAt} now={now} />
                  </dd>
                </div>
                {s.status === 'ended' && s.endReason ? (
                  <div>
                    <dt>Ended</dt>
                    <dd>{s.endReason}</dd>
                  </div>
                ) : null}
              </dl>
              {s.cwd ? <p className="session-cwd mono" title={s.cwd}>{s.cwd}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
