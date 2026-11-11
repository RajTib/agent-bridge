import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentSession,
  AuditEvent,
  Decision,
  LiveMessage,
  MockCallView,
  Overview,
  PhoneCall,
} from '@agentbridge/shared';
import { api, ApiError, errorMessage, setUnauthorizedHandler } from './api';
import { useLive } from './useLive';
import { useNow } from './time';
import { Login } from './components/Login';
import { Header } from './components/Header';
import { StatCards } from './components/StatCards';
import { PendingApprovals } from './components/PendingApprovals';
import { MockPhone } from './components/MockPhone';
import { CallsTable } from './components/CallsTable';
import { SessionsList } from './components/SessionsList';
import { DecisionHistory, type HistoryTab } from './components/DecisionHistory';
import { DecisionDrawer } from './components/DecisionDrawer';
import { Timeline } from './components/Timeline';
import { ConfigPanel } from './components/ConfigPanel';
import { Section } from './components/common';

type AuthState = 'checking' | 'in' | 'out';

const MAX_EVENTS = 200;
const MAX_CALLS = 50;
const MAX_HISTORY = 100;
const MAX_MOCK = 6;

function upsert<K, V>(prev: Map<K, V>, key: K, value: V): Map<K, V> {
  const next = new Map(prev);
  next.set(key, value);
  return next;
}

function mapBy<K, V>(items: V[], key: (v: V) => K, base?: Map<K, V>): Map<K, V> {
  const next = new Map(base);
  for (const it of items) next.set(key(it), it);
  return next;
}

const byNewest = (a: { createdAt: string }, b: { createdAt: string }) =>
  Date.parse(b.createdAt) - Date.parse(a.createdAt);

export function App() {
  const [auth, setAuth] = useState<AuthState>('checking');

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api
      .me()
      .then((r) => setAuth(r.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('out'));
    return () => setUnauthorizedHandler(null);
  }, []);

  if (auth === 'checking') {
    return (
      <main className="login-wrap" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }
  if (auth === 'out') return <Login onSuccess={() => setAuth('in')} />;
  return <Dashboard onLoggedOut={() => setAuth('out')} />;
}

function Dashboard({ onLoggedOut }: { onLoggedOut: () => void }) {
  const now = useNow(1000);

  const [overview, setOverview] = useState<Overview | null>(null);
  const [decisions, setDecisions] = useState<Map<string, Decision>>(() => new Map());
  const [sessions, setSessions] = useState<Map<string, AgentSession>>(() => new Map());
  const [calls, setCalls] = useState<Map<string, PhoneCall>>(() => new Map());
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [mockCalls, setMockCalls] = useState<Map<string, MockCallView>>(() => new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [historyTab, setHistoryTab] = useState<HistoryTab>('all');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const historyTabRef = useRef(historyTab);
  useEffect(() => {
    historyTabRef.current = historyTab;
  }, [historyTab]);

  const isMock = overview?.provider.name === 'mock';

  const loadMock = useCallback(async () => {
    try {
      const res = await api.mockCalls();
      setMockCalls(mapBy(res.calls, (m) => m.callId));
    } catch {
      /* simulator endpoint may be unavailable for non-mock providers */
    }
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const ov = await api.overview();
      setOverview(ov);
      return ov;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setLoadError(errorMessage(err));
      return null;
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [ov, pending, history, sess, cl, ev] = await Promise.all([
        api.overview(),
        api.decisions('pending', 100),
        api.decisions(historyTabRef.current, MAX_HISTORY),
        api.sessions(),
        api.calls(MAX_CALLS),
        api.events(MAX_EVENTS),
      ]);
      setOverview(ov);
      // Replace pending wholesale so stale "pending" entries do not linger after a reconnect.
      setDecisions((prev) => {
        const kept = [...prev.values()].filter((d) => d.status !== 'pending');
        return mapBy([...history.decisions, ...pending.decisions], (d) => d.id, mapBy(kept, (d) => d.id));
      });
      setSessions(mapBy(sess.sessions, (s) => s.id));
      setCalls(mapBy(cl.calls, (c) => c.id));
      setEvents(ev.events.slice(0, MAX_EVENTS));
      setLoadError(null);
      if (ov.provider.name === 'mock') await loadMock();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) setLoadError(errorMessage(err));
    }
  }, [loadMock]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // History tab fetch.
  const loadHistory = useCallback(async (tab: HistoryTab) => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await api.decisions(tab, MAX_HISTORY);
      setDecisions((prev) => mapBy(res.decisions, (d) => d.id, prev));
    } catch (err) {
      setHistoryError(errorMessage(err));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const selectTab = (tab: HistoryTab) => {
    setHistoryTab(tab);
    void loadHistory(tab);
  };

  // Debounced overview refresh so counters follow live changes.
  const overviewTimer = useRef<number | undefined>(undefined);
  const scheduleOverview = useCallback(() => {
    window.clearTimeout(overviewTimer.current);
    overviewTimer.current = window.setTimeout(() => void loadOverview(), 800);
  }, [loadOverview]);
  useEffect(() => () => window.clearTimeout(overviewTimer.current), []);

  const onMessage = useCallback(
    (msg: LiveMessage) => {
      switch (msg.kind) {
        case 'decision':
          setDecisions((prev) => upsert(prev, msg.decision.id, msg.decision));
          scheduleOverview();
          break;
        case 'session':
          setSessions((prev) => upsert(prev, msg.session.id, msg.session));
          scheduleOverview();
          break;
        case 'call':
          setCalls((prev) => upsert(prev, msg.call.id, msg.call));
          scheduleOverview();
          break;
        case 'event':
          setEvents((prev) => {
            if (prev.some((e) => e.id === msg.event.id)) return prev;
            return [msg.event, ...prev].slice(0, MAX_EVENTS);
          });
          break;
        case 'mock-call':
          setMockCalls((prev) => upsert(prev, msg.mock.callId, msg.mock));
          break;
      }
    },
    [scheduleOverview],
  );

  const onClosed = useCallback(() => {
    // The stream closes for good on 401; confirm and drop to the login screen if so.
    api
      .me()
      .then((r) => {
        if (!r.authenticated) onLoggedOut();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) onLoggedOut();
      });
  }, [onLoggedOut]);

  const live = useLive(true, { onMessage, onReconnect: () => void loadAll(), onClosed });

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      /* cookie is cleared server-side or already gone; either way show login */
    }
    onLoggedOut();
  };

  // Derived views.
  const pending = useMemo(
    () =>
      [...decisions.values()]
        .filter((d) => d.status === 'pending')
        .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt)),
    [decisions],
  );

  const history = useMemo(
    () =>
      [...decisions.values()]
        .filter((d) => (historyTab === 'all' ? true : d.status === historyTab))
        .sort(byNewest)
        .slice(0, MAX_HISTORY),
    [decisions, historyTab],
  );

  const sessionList = useMemo(
    () =>
      [...sessions.values()].sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      }),
    [sessions],
  );

  const callList = useMemo(() => [...calls.values()].sort(byNewest).slice(0, MAX_CALLS), [calls]);

  const mockList = useMemo(() => {
    const all = [...mockCalls.values()].reverse();
    const activeFirst = [...all.filter((m) => m.state !== 'ended'), ...all.filter((m) => m.state === 'ended')];
    return activeFirst.slice(0, MAX_MOCK);
  }, [mockCalls]);

  const activeSessions = sessionList.filter((s) => s.status === 'active').length;
  const canCall = overview?.provider.enabled === true;

  useEffect(() => {
    const base = 'AgentBridge';
    document.title = pending.length > 0 ? `(${pending.length}) ${base}` : base;
  }, [pending.length]);

  return (
    <div className="app">
      <a className="skip-link" href="#pending">
        Skip to pending approvals
      </a>
      <Header live={live} provider={overview?.provider ?? null} version={overview?.version ?? null} onLogout={logout} />

      <main className="main">
        {loadError ? (
          <div className="banner banner-error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadAll()}>
              Retry
            </button>
          </div>
        ) : null}
        {live === 'offline' || live === 'reconnecting' ? (
          <div className="banner banner-warn" role="status">
            Live updates are {live === 'offline' ? 'offline' : 'reconnecting'}. Data may be stale; it will refresh
            automatically once the connection returns.
          </div>
        ) : null}

        <StatCards overview={overview} pendingCount={pending.length} activeSessions={activeSessions} />

        <div className="grid-main">
          <div className="col">
            <PendingApprovals
              decisions={pending}
              now={now}
              canCall={canCall}
              onUpdate={(d) => setDecisions((prev) => upsert(prev, d.id, d))}
            />
            {isMock ? (
              <MockPhone
                calls={mockList}
                decisions={decisions}
                onUpdate={(m) => setMockCalls((prev) => upsert(prev, m.callId, m))}
              />
            ) : null}
          </div>
          <div className="col">
            <Section title="Agent timeline" id="timeline" count={events.length} className="panel-timeline">
              <div className="timeline-scroll">
                <Timeline events={events} now={now} onOpenDecision={setOpenId} />
              </div>
            </Section>
          </div>
        </div>

        <CallsTable calls={callList} decisions={decisions} onOpenDecision={setOpenId} />

        <div className="grid-two">
          <SessionsList sessions={sessionList} now={now} />
          <DecisionHistory
            decisions={history}
            tab={historyTab}
            onTab={selectTab}
            loading={historyLoading}
            error={historyError}
            onOpen={setOpenId}
          />
        </div>

        <ConfigPanel overview={overview} now={now} />

        <footer className="footer muted">
          AgentBridge{overview ? ` v${overview.version}` : ''} · Phone approvals for Claude Code
        </footer>
      </main>

      {openId ? (
        <DecisionDrawer key={openId} id={openId} live={decisions.get(openId)} now={now} onClose={() => setOpenId(null)} />
      ) : null}
    </div>
  );
}
