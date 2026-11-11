import { useEffect, useRef, useState } from 'react';
import type { LiveMessage } from '@agentbridge/shared';

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

interface LiveHandlers {
  onMessage: (msg: LiveMessage) => void;
  /** Fired when the stream (re)opens after having been down; refetch state here. */
  onReconnect: () => void;
  /** Fired when the browser gave up on the stream (e.g. 401 or server down). */
  onClosed?: () => void;
}

const KINDS = new Set(['decision', 'session', 'call', 'event', 'mock-call']);

function parseMessage(raw: string): LiveMessage | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === 'object' && KINDS.has((data as { kind?: string }).kind ?? '')) {
      return data as LiveMessage;
    }
  } catch {
    /* ignore malformed frames (e.g. keep-alive comments) */
  }
  return null;
}

/**
 * Subscribes to /api/stream via EventSource while `enabled`. The browser retries
 * transient drops itself ("reconnecting"); if it closes the stream for good we
 * back off and open a fresh EventSource ("offline" meanwhile).
 */
export function useLive(enabled: boolean, handlers: LiveHandlers): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const handlersRef = useRef(handlers);

  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;

    let es: EventSource | null = null;
    let retryTimer: number | undefined;
    let attempts = 0;
    let everOpened = false;
    let wasDown = false;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      es = new EventSource('/api/stream', { withCredentials: true });

      es.onopen = () => {
        attempts = 0;
        setStatus('live');
        if (everOpened && wasDown) handlersRef.current.onReconnect();
        everOpened = true;
        wasDown = false;
      };

      es.onmessage = (ev: MessageEvent<string>) => {
        const msg = parseMessage(ev.data);
        if (msg) handlersRef.current.onMessage(msg);
      };

      es.onerror = () => {
        wasDown = true;
        if (!es || es.readyState === EventSource.CLOSED) {
          es?.close();
          es = null;
          setStatus('offline');
          handlersRef.current.onClosed?.();
          attempts += 1;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5));
          retryTimer = window.setTimeout(() => {
            everOpened = true; // any successful open after this counts as a reconnect
            connect();
          }, delay);
        } else {
          setStatus('reconnecting');
        }
      };
    };

    setStatus('connecting');
    connect();

    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      es?.close();
    };
  }, [enabled]);

  return enabled ? status : 'offline';
}
