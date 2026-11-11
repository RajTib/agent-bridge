import { useEffect, useRef, useState } from 'react';
import type { Decision } from '@agentbridge/shared';
import { api, errorMessage } from '../api';
import { formatDuration, formatFull, formatTime, relativeTime, secondsUntil } from '../time';
import { CopyId, Empty, RiskBadge, Section, StatusChip } from './common';

interface PendingProps {
  decisions: Decision[];
  now: number;
  canCall: boolean;
  onUpdate: (d: Decision) => void;
}

export function PendingApprovals({ decisions, now, canCall, onUpdate }: PendingProps) {
  return (
    <Section title="Pending approvals" id="pending" count={decisions.length} className="panel-primary">
      <div className="pending-list" aria-live="polite" aria-relevant="additions removals">
        {decisions.length === 0 ? (
          <Empty>Nothing waiting. Your agents will show up here when they need permission.</Empty>
        ) : (
          decisions.map((d) => (
            <DecisionCard key={d.id} decision={d} now={now} canCall={canCall} onUpdate={onUpdate} />
          ))
        )}
      </div>
    </Section>
  );
}

type Busy = null | 'approve' | 'reject' | 'call';

interface CardProps {
  decision: Decision;
  now: number;
  canCall: boolean;
  onUpdate: (d: Decision) => void;
}

const CONFIRM_WINDOW_MS = 4000;

function DecisionCard({ decision: d, now, canCall, onUpdate }: CardProps) {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const confirmTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(confirmTimer.current), []);

  const remaining = secondsUntil(d.expiresAt, now);
  const expired = remaining !== null && remaining <= 0;
  const urgent = remaining !== null && remaining > 0 && remaining <= 60;
  const isHigh = d.risk === 'high';

  const run = async (kind: Exclude<Busy, null>) => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      if (kind === 'approve') onUpdate((await api.approve(d.id)).decision);
      else if (kind === 'reject') onUpdate((await api.reject(d.id)).decision);
      else {
        await api.callMe(d.id);
        setNotice('Calling you now…');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const onApprove = () => {
    if (isHigh && !confirming) {
      setConfirming(true);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(false), CONFIRM_WINDOW_MS);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(false);
    void run('approve');
  };

  const disabled = busy !== null;

  return (
    <article className={`decision-card risk-edge-${d.risk}`} aria-label={`${d.toolName} in ${d.projectName}`}>
      <div className="dc-top">
        <div className="dc-title">
          <span className="dc-project">{d.projectName}</span>
          <span className="tool mono">{d.toolName}</span>
        </div>
        <div className="dc-badges">
          <RiskBadge risk={d.risk} />
          <StatusChip status={d.status} />
        </div>
      </div>

      <p className="dc-summary">{d.summary}</p>

      {d.riskReasons.length > 0 ? (
        <ul className="risk-reasons">
          {d.riskReasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}

      <div className="dc-meta">
        <span>
          Session <CopyId id={d.sessionId} label="Session ID" />
        </span>
        <span>{d.agent}</span>
        <span title={formatFull(d.createdAt)}>
          Requested {formatTime(d.createdAt)} ({relativeTime(d.createdAt, now)})
        </span>
        <span
          className={`countdown ${expired ? 'is-expired' : urgent ? 'is-urgent' : ''}`}
          title={`Expires ${formatFull(d.expiresAt)}`}
        >
          {remaining === null
            ? 'No expiry'
            : expired
              ? 'Timed out, finalising…'
              : `Expires in ${formatDuration(remaining)}`}
        </span>
      </div>

      <details className="dc-details">
        <summary>Full details</summary>
        {d.cwd ? (
          <p className="dc-cwd">
            <span className="muted">cwd</span> <span className="mono">{d.cwd}</span>
          </p>
        ) : null}
        <pre className="detail-pre" tabIndex={0}>
          {d.detail}
        </pre>
      </details>

      <div className="dc-actions">
        <button
          type="button"
          className={`btn ${confirming ? 'btn-confirm' : 'btn-approve'}`}
          onClick={onApprove}
          disabled={disabled}
          aria-describedby={isHigh ? `hr-${d.id}` : undefined}
        >
          {busy === 'approve' ? 'Approving…' : confirming ? 'Confirm approve' : 'Approve'}
        </button>
        <button type="button" className="btn btn-reject" onClick={() => void run('reject')} disabled={disabled}>
          {busy === 'reject' ? 'Rejecting…' : 'Reject'}
        </button>
        {canCall ? (
          <button type="button" className="btn btn-ghost" onClick={() => void run('call')} disabled={disabled}>
            {busy === 'call' ? 'Calling…' : 'Call me'}
          </button>
        ) : null}
        {isHigh ? (
          <span id={`hr-${d.id}`} className="sr-only">
            High risk: approving requires a second click to confirm.
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="inline-notice" role="status">
          {notice}
        </p>
      ) : null}
    </article>
  );
}
