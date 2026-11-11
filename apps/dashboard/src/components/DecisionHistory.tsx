import type { Decision } from '@agentbridge/shared';
import type { DecisionFilter } from '../api';
import { formatFull, formatTime } from '../time';
import { ChannelTag, Empty, RiskBadge, Section, StatusChip } from './common';

export type HistoryTab = Exclude<DecisionFilter, 'pending'>;

const TABS: { id: HistoryTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'expired', label: 'Expired' },
  { id: 'cancelled', label: 'Cancelled' },
];

interface HistoryProps {
  decisions: Decision[];
  tab: HistoryTab;
  onTab: (t: HistoryTab) => void;
  loading: boolean;
  error: string | null;
  onOpen: (id: string) => void;
}

export function DecisionHistory({ decisions, tab, onTab, loading, error, onOpen }: HistoryProps) {
  return (
    <Section title="Decision history" id="history">
      <div className="tabs" role="tablist" aria-label="Filter decisions">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            aria-controls="history-panel"
            className={`tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="history-panel" role="tabpanel" aria-busy={loading}>
        {error ? <p className="inline-error">{error}</p> : null}
        {decisions.length === 0 ? (
          <Empty>{loading ? 'Loading…' : 'No decisions in this view.'}</Empty>
        ) : (
          <ul className="history-list">
            {decisions.map((d) => (
              <li key={d.id}>
                <button type="button" className="history-row" onClick={() => onOpen(d.id)}>
                  <span className="hr-main">
                    <span className="hr-title">
                      <span className="hr-project">{d.projectName}</span>
                      <span className="tool mono">{d.toolName}</span>
                    </span>
                    <span className="hr-summary">{d.summary}</span>
                  </span>
                  <span className="hr-side">
                    <span className="hr-chips">
                      <StatusChip status={d.status} />
                      <RiskBadge risk={d.risk} />
                      <ChannelTag channel={d.resolutionChannel} />
                    </span>
                    <span className="hr-times muted">
                      <span title={formatFull(d.createdAt)}>Asked {formatTime(d.createdAt)}</span>
                      {d.resolvedAt ? (
                        <span title={formatFull(d.resolvedAt)}>
                          {' · '}Resolved {formatTime(d.resolvedAt)}
                          {d.resolvedBy ? ` by ${d.resolvedBy}` : ''}
                        </span>
                      ) : null}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
