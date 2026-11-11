import type { AuditEvent } from '@agentbridge/shared';
import { Empty, RelTime } from './common';

interface TimelineProps {
  events: AuditEvent[];
  now: number;
  onOpenDecision?: (id: string) => void;
  compact?: boolean;
}

/** Newest-first list of audit events, coloured by level. */
export function Timeline({ events, now, onOpenDecision, compact }: TimelineProps) {
  if (events.length === 0) return <Empty>No events yet.</Empty>;
  return (
    <ol className={`timeline ${compact ? 'timeline-compact' : ''}`}>
      {events.map((e) => {
        const decisionId = e.decisionId;
        return (
        <li key={e.id} className={`tl-item level-${e.level}`}>
          <span className="tl-dot" aria-hidden="true" />
          <div className="tl-body">
            <div className="tl-head">
              <span className={`type-chip type-${e.type.split('.')[0]}`}>{e.type}</span>
              <RelTime iso={e.ts} now={now} />
            </div>
            <p className="tl-msg">
              {e.level !== 'info' ? <span className="sr-only">{e.level}: </span> : null}
              {e.message}
            </p>
            {onOpenDecision && decisionId ? (
              <button type="button" className="link-btn tl-link" onClick={() => onOpenDecision(decisionId)}>
                View decision
              </button>
            ) : null}
          </div>
        </li>
        );
      })}
    </ol>
  );
}
