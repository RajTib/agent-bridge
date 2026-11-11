import type { Overview } from '@agentbridge/shared';

interface StatCardsProps {
  overview: Overview | null;
  pendingCount: number;
  activeSessions: number;
}

export function StatCards({ overview, pendingCount, activeSessions }: StatCardsProps) {
  const calls = overview?.callStats;
  const dc = overview?.decisionCounts;
  const v = (n: number | undefined) => (n === undefined ? '—' : n);

  return (
    <div className="stats" role="list">
      <a href="#pending" className={`stat stat-link ${pendingCount > 0 ? 'stat-alert' : ''}`} role="listitem">
        <span className="stat-label">Pending approvals</span>
        <span className="stat-value">{pendingCount}</span>
        <span className="stat-sub">{pendingCount > 0 ? 'Waiting on you' : 'All clear'}</span>
      </a>

      <a href="#sessions" className="stat stat-link" role="listitem">
        <span className="stat-label">Active sessions</span>
        <span className="stat-value">{activeSessions}</span>
        <span className="stat-sub">Claude Code agents</span>
      </a>

      <div className="stat stat-wide" role="listitem">
        <span className="stat-label">Phone calls</span>
        <span className="stat-value">{v(calls?.total)}</span>
        <dl className="stat-grid">
          <div>
            <dt>Answered</dt>
            <dd>{v(calls?.answered)}</dd>
          </div>
          <div>
            <dt>Approved</dt>
            <dd className="t-green">{v(calls?.approved)}</dd>
          </div>
          <div>
            <dt>Rejected</dt>
            <dd className="t-red">{v(calls?.rejected)}</dd>
          </div>
          <div>
            <dt>No response</dt>
            <dd className="t-amber">{v(calls?.noResponse)}</dd>
          </div>
          <div>
            <dt>Failed</dt>
            <dd className="t-red">{v(calls?.failed)}</dd>
          </div>
        </dl>
      </div>

      <div className="stat stat-wide" role="listitem">
        <span className="stat-label">Decisions</span>
        <span className="stat-value">
          {dc ? Object.values(dc).reduce((a, b) => a + b, 0) : '—'}
        </span>
        <dl className="stat-grid">
          <div>
            <dt>Approved</dt>
            <dd className="t-green">{v(dc?.approved)}</dd>
          </div>
          <div>
            <dt>Rejected</dt>
            <dd className="t-red">{v(dc?.rejected)}</dd>
          </div>
          <div>
            <dt>Expired</dt>
            <dd className="t-amber">{v(dc?.expired)}</dd>
          </div>
          <div>
            <dt>Cancelled</dt>
            <dd>{v(dc?.cancelled)}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
