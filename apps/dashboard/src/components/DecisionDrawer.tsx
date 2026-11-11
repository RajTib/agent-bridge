import { useEffect, useRef, useState } from 'react';
import type { Decision } from '@agentbridge/shared';
import { api, errorMessage, type DecisionDetail } from '../api';
import { formatFull, formatTime } from '../time';
import { ChannelTag, CopyId, RiskBadge, StatusChip } from './common';
import { Timeline } from './Timeline';

interface DrawerProps {
  id: string;
  /** Latest live copy of the decision, if we have one, so status stays current. */
  live: Decision | undefined;
  now: number;
  onClose: () => void;
}

export function DecisionDrawer({ id, live, now, onClose }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<DecisionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  // Refetch when the live decision changes (e.g. resolved while open).
  const liveStamp = live ? `${live.status}|${live.resolvedAt ?? ''}` : '';
  useEffect(() => {
    let cancelled = false;
    api
      .decision(id)
      .then((res) => {
        if (!cancelled) {
          setData(res);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id, liveStamp]);

  const d = live ?? data?.decision;

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby="drawer-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <div className="drawer-inner">
        <header className="drawer-head">
          <h2 id="drawer-title">{d ? `${d.projectName} · ${d.toolName}` : 'Decision'}</h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ref.current?.close()} autoFocus>
            Close
          </button>
        </header>

        {error ? <p className="inline-error">{error}</p> : null}
        {!d && !error ? <p className="empty">Loading…</p> : null}

        {d ? (
          <>
            <div className="drawer-chips">
              <StatusChip status={d.status} />
              <RiskBadge risk={d.risk} />
              <ChannelTag channel={d.resolutionChannel} />
            </div>
            <p className="dc-summary">{d.summary}</p>
            {d.riskReasons.length > 0 ? (
              <ul className="risk-reasons">
                {d.riskReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            ) : null}

            <dl className="kv">
              <div>
                <dt>Decision</dt>
                <dd>
                  <CopyId id={d.id} label="Decision ID" />
                </dd>
              </div>
              <div>
                <dt>Session</dt>
                <dd>
                  <CopyId id={d.sessionId} label="Session ID" />
                </dd>
              </div>
              <div>
                <dt>Agent</dt>
                <dd>{d.agent}</dd>
              </div>
              {d.cwd ? (
                <div>
                  <dt>cwd</dt>
                  <dd className="mono wrap">{d.cwd}</dd>
                </div>
              ) : null}
              <div>
                <dt>Created</dt>
                <dd title={formatFull(d.createdAt)}>{formatTime(d.createdAt)}</dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd title={formatFull(d.expiresAt)}>{formatTime(d.expiresAt)}</dd>
              </div>
              <div>
                <dt>Resolved</dt>
                <dd title={formatFull(d.resolvedAt)}>
                  {d.resolvedAt ? formatTime(d.resolvedAt) : '—'}
                  {d.resolvedBy ? ` by ${d.resolvedBy}` : ''}
                </dd>
              </div>
              {d.resolutionNote ? (
                <div>
                  <dt>Note</dt>
                  <dd className="wrap">{d.resolutionNote}</dd>
                </div>
              ) : null}
            </dl>

            <h3 className="drawer-sub">Full details</h3>
            <pre className="detail-pre" tabIndex={0}>
              {d.detail}
            </pre>

            <h3 className="drawer-sub">Phone calls</h3>
            {data && data.calls.length > 0 ? (
              <ul className="drawer-calls">
                {data.calls.map((c) => (
                  <li key={c.id}>
                    <span className="mono">#{c.attempt}</span> {formatTime(c.createdAt)} · {c.provider}
                    {!c.isRealCall ? <span className="tag tag-sim">simulated</span> : null} ·{' '}
                    <span className="mono">{c.toMasked}</span> ·{' '}
                    <span className={`chip call-${c.status}`}>{c.status.replace('_', ' ')}</span>
                    {c.result ? <span className={`chip result-${c.result}`}>{c.result.replace('_', ' ')}</span> : null}
                    <span className="muted">
                      {' '}
                      · {c.promptsPlayed} prompts, {c.invalidInputs} invalid
                    </span>
                    {c.error ? <span className="t-red wrap"> · {c.error}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">{data ? 'No calls for this decision.' : 'Loading…'}</p>
            )}

            <h3 className="drawer-sub">Timeline</h3>
            {data ? (
              <Timeline events={[...data.events].sort((a, b) => b.id - a.id)} now={now} compact />
            ) : (
              <p className="empty">Loading…</p>
            )}
          </>
        ) : null}
      </div>
    </dialog>
  );
}
