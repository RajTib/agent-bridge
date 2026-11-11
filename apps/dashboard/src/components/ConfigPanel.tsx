import type { Overview } from '@agentbridge/shared';
import { formatFull, relativeTime } from '../time';
import { RiskBadge, Section } from './common';
import { describeProvider } from './Header';

export function ConfigPanel({ overview, now }: { overview: Overview | null; now: number }) {
  if (!overview) {
    return (
      <Section title="Configuration & provider" id="config">
        <p className="empty">Loading…</p>
      </Section>
    );
  }
  const { provider: p, config: c } = overview;
  const { tone, label } = describeProvider(p);
  const yesNo = (b: boolean) => (b ? 'Yes' : 'No');

  return (
    <Section title="Configuration & provider" id="config">
      <div className="config-grid">
        <div className="config-block">
          <h3>Phone provider</h3>
          <p>
            <span className={`pill provider-${tone}`}>
              <span className="dot" aria-hidden="true" />
              {label}
            </span>
          </p>
          <dl className="kv">
            <div>
              <dt>Provider</dt>
              <dd className="mono">{p.name || '—'}</dd>
            </div>
            <div>
              <dt>Call type</dt>
              <dd>{p.isRealCall ? 'Real phone calls' : 'Simulated (no real calls)'}</dd>
            </div>
            <div>
              <dt>Configured</dt>
              <dd>{yesNo(p.configured)}</dd>
            </div>
            <div>
              <dt>Enabled</dt>
              <dd>{yesNo(p.enabled)}</dd>
            </div>
            <div>
              <dt>Calls go to</dt>
              <dd className="mono">{p.toMasked ?? '—'}</dd>
            </div>
            <div>
              <dt>Public URL</dt>
              <dd className="mono wrap">{p.publicUrl ?? '—'}</dd>
            </div>
          </dl>
          {p.problems.length > 0 ? (
            <div className="problems" role="note">
              <p className="problems-title">Problems</p>
              <ul>
                {p.problems.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="t-green small">No provider problems detected.</p>
          )}
        </div>

        <div className="config-block">
          <h3>Approvals</h3>
          <dl className="kv">
            <div>
              <dt>Approval timeout</dt>
              <dd>{c.approvalTimeoutSeconds}s</dd>
            </div>
            <div>
              <dt>On timeout</dt>
              <dd>
                {c.timeoutBehavior === 'ask'
                  ? "Ask — falls back to Claude Code's own prompt"
                  : 'Deny — the action is refused'}
              </dd>
            </div>
            <div>
              <dt>Call at risk ≥</dt>
              <dd>
                <RiskBadge risk={c.callMinRisk} />
              </dd>
            </div>
            <div>
              <dt>Max call attempts</dt>
              <dd>{c.callMaxAttempts}</dd>
            </div>
            <div>
              <dt>DTMF prompts</dt>
              <dd>{c.dtmfMaxPrompts}</dd>
            </div>
            <div>
              <dt>Ring timeout</dt>
              <dd>{c.ringTimeoutSeconds}s</dd>
            </div>
          </dl>
        </div>

        <div className="config-block">
          <h3>Voice & notifications</h3>
          <dl className="kv">
            <div>
              <dt>Voice</dt>
              <dd className="mono">{c.voice}</dd>
            </div>
            <div>
              <dt>Language</dt>
              <dd className="mono">{c.language}</dd>
            </div>
            <div>
              <dt>Discord</dt>
              <dd>{overview.discordEnabled ? 'Enabled' : 'Disabled'}</dd>
            </div>
            <div>
              <dt>Server version</dt>
              <dd className="mono">{overview.version}</dd>
            </div>
            <div>
              <dt>Server started</dt>
              <dd title={formatFull(overview.serverStartedAt)}>{relativeTime(overview.serverStartedAt, now)}</dd>
            </div>
          </dl>
        </div>
      </div>
    </Section>
  );
}
