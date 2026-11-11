import type { ProviderStatus } from '@agentbridge/shared';
import type { LiveStatus } from '../useLive';

export type ProviderTone = 'real' | 'mock' | 'off';

export function describeProvider(p: ProviderStatus | null): { tone: ProviderTone; label: string } {
  if (!p || !p.enabled) return { tone: 'off', label: 'Phone calls disabled' };
  const name = p.name ? p.name.charAt(0).toUpperCase() + p.name.slice(1) : 'Unknown';
  if (p.isRealCall) return { tone: 'real', label: `${name} · real calls` };
  return { tone: 'mock', label: `${name} · simulated, no real calls` };
}

const LIVE_LABEL: Record<LiveStatus, string> = {
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

interface HeaderProps {
  live: LiveStatus;
  provider: ProviderStatus | null;
  version: string | null;
  onLogout: () => void;
}

export function Header({ live, provider, version, onLogout }: HeaderProps) {
  const { tone, label } = describeProvider(provider);
  const problems = provider?.problems ?? [];

  return (
    <header className="topbar">
      <div className="brand">
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M6 20c3-8 17-8 20 0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          <circle cx="9" cy="22" r="3" className="brand-dot-a" />
          <circle cx="23" cy="22" r="3" className="brand-dot-b" />
        </svg>
        <span className="wordmark">
          Agent<strong>Bridge</strong>
        </span>
        {version ? <span className="version">v{version}</span> : null}
      </div>

      <div className="topbar-pills">
        <span className={`pill live-${live}`} role="status" aria-live="polite">
          <span className="dot" aria-hidden="true" />
          {LIVE_LABEL[live]}
        </span>

        {problems.length > 0 ? (
          <details className={`pill-details provider-${tone}`}>
            <summary className={`pill provider-${tone}`} title={problems.join('\n')}>
              <span className="dot" aria-hidden="true" />
              {label}
              <span className="pill-warn" aria-label={`${problems.length} provider problems`}>
                {problems.length}!
              </span>
            </summary>
            <div className="popover" role="note">
              <p className="popover-title">Provider problems</p>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          </details>
        ) : (
          <span className={`pill provider-${tone}`}>
            <span className="dot" aria-hidden="true" />
            {label}
          </span>
        )}

        <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
          Log out
        </button>
      </div>
    </header>
  );
}
