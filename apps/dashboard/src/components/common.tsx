import { useState, type ReactNode } from 'react';
import type { DecisionStatus, ResolutionChannel, RiskLevel } from '@agentbridge/shared';
import { formatFull, relativeTime } from '../time';

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <span className={`badge risk-${risk}`}>{risk} risk</span>;
}

export function StatusChip({ status }: { status: DecisionStatus }) {
  return <span className={`chip status-${status}`}>{status}</span>;
}

export function ChannelTag({ channel }: { channel: ResolutionChannel | null }) {
  if (!channel) return <span className="muted">—</span>;
  return <span className={`tag channel-${channel}`}>{channel}</span>;
}

export function shortId(id: string, len = 8): string {
  return id.length > len + 2 ? `${id.slice(0, len)}…` : id;
}

/** Shortened id; full value on hover; click copies it to the clipboard. */
export function CopyId({ id, label = 'ID' }: { id: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context); hover still shows the full id */
    }
  };
  return (
    <button
      type="button"
      className="copy-id mono"
      title={`${label}: ${id} (click to copy)`}
      aria-label={`Copy ${label} ${id}`}
      onClick={copy}
    >
      {copied ? 'copied' : shortId(id)}
    </button>
  );
}

export function RelTime({ iso, now }: { iso: string | null | undefined; now: number }) {
  if (!iso) return <span className="muted">—</span>;
  return (
    <time dateTime={iso} title={formatFull(iso)}>
      {relativeTime(iso, now)}
    </time>
  );
}

interface SectionProps {
  title: string;
  id?: string;
  count?: number | null;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Section({ title, id, count, actions, className, children }: SectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`panel ${className ?? ''}`} id={id} aria-labelledby={headingId}>
      <header className="panel-head">
        <h2 id={headingId}>
          {title}
          {count !== undefined && count !== null ? <span className="count">{count}</span> : null}
        </h2>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}
