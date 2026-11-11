import { useEffect, useState } from 'react';

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** "just now", "42s ago", "5m ago", "3h ago", "2d ago"; future times read "in 5m". */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  const ms = toMs(iso);
  if (ms === null) return '—';
  const diff = Math.round((now - ms) / 1000);
  const abs = Math.abs(diff);
  let text: string;
  if (abs < 5) return 'just now';
  if (abs < 60) text = `${abs}s`;
  else if (abs < 3600) text = `${Math.floor(abs / 60)}m`;
  else if (abs < 86400) text = `${Math.floor(abs / 3600)}h`;
  else text = `${Math.floor(abs / 86400)}d`;
  return diff >= 0 ? `${text} ago` : `in ${text}`;
}

/** Seconds remaining until `iso` (negative once passed), or null when unparseable. */
export function secondsUntil(iso: string, now: number = Date.now()): number | null {
  const ms = toMs(iso);
  return ms === null ? null : Math.round((ms - now) / 1000);
}

/** 754 -> "12:34", 3725 -> "1:02:05". */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Short local timestamp; includes the date only when it is not today. */
export function formatTime(iso: string | null | undefined): string {
  const ms = toMs(iso);
  if (ms === null) return '—';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`;
}

/** Full timestamp for tooltips. */
export function formatFull(iso: string | null | undefined): string {
  const ms = toMs(iso);
  return ms === null ? '' : new Date(ms).toLocaleString();
}

/** Re-renders the caller every `intervalMs` and returns the current epoch ms. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
