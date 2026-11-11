import { describe, expect, it } from 'vitest';
import { openDatabase } from './db.js';
import { Store } from './store.js';
import { Audit, EventBus } from './bus.js';
import { SessionService } from './sessions.js';
import { DecisionService, type PermissionRequestInput } from './decisions.js';

function setup(opts: { timeoutSeconds?: number; grace?: number } = {}) {
  let clock = new Date('2026-11-11T10:00:00.000Z');
  const now = () => clock;
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const store = new Store(openDatabase(':memory:'));
  const bus = new EventBus();
  const audit = new Audit(store, bus, now);
  const sessions = new SessionService(store, bus, audit, now);
  const decisions = new DecisionService({
    store,
    bus,
    audit,
    sessions,
    timeoutSeconds: opts.timeoutSeconds ?? 300,
    heartbeatGraceSeconds: opts.grace ?? 60,
    now,
  });
  return { store, bus, decisions, sessions, advance };
}

const req = (over: Partial<PermissionRequestInput> = {}): PermissionRequestInput => ({
  sessionId: 'sess-A',
  agent: 'claude-code',
  cwd: '/home/dev/projects/shop-api',
  toolName: 'Bash',
  toolInput: { command: 'npm install jsonwebtoken', description: 'Install jsonwebtoken' },
  ...over,
});

describe('DecisionService', () => {
  it('creates a pending decision with project, summary, risk and an unguessable id', () => {
    const { decisions } = setup();
    const { decision, duplicate } = decisions.create(req());
    expect(duplicate).toBe(false);
    expect(decision.status).toBe('pending');
    expect(decision.projectName).toBe('shop-api');
    expect(decision.spokenSummary).toBe('install a new dependency called jsonwebtoken');
    expect(decision.risk).toBe('medium');
    expect(decision.id).toMatch(/^dec_[A-Za-z0-9_-]{22}$/);
    expect(decision.expiresAt).toBe('2026-11-11T10:05:00.000Z');
  });

  it('collapses an identical pending request into the existing decision (duplicate protection)', () => {
    const { decisions } = setup();
    const a = decisions.create(req());
    const b = decisions.create(req({ toolInput: { description: 'Install jsonwebtoken', command: 'npm install jsonwebtoken' } }));
    expect(b.duplicate).toBe(true);
    expect(b.decision.id).toBe(a.decision.id);
    expect(decisions.list({ status: 'pending' })).toHaveLength(1);
  });

  it('does not treat the same command in a different session as a duplicate', () => {
    const { decisions } = setup();
    const a = decisions.create(req());
    const b = decisions.create(req({ sessionId: 'sess-B' }));
    expect(b.duplicate).toBe(false);
    expect(b.decision.id).not.toBe(a.decision.id);
  });

  it('approves exactly one decision and leaves other sessions untouched (session isolation)', () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    const b = decisions.create(req({ sessionId: 'sess-B', toolInput: { command: 'rm -rf dist' } })).decision;
    const r = decisions.resolve(a.id, 'approved', { channel: 'phone', by: 'phone:+91******3210' });
    expect(r.ok).toBe(true);
    expect(decisions.get(a.id)!.status).toBe('approved');
    expect(decisions.get(b.id)!.status).toBe('pending');
  });

  it('rejects a decision', () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    const r = decisions.resolve(a.id, 'rejected', { channel: 'dashboard', by: 'dashboard' });
    expect(r.ok && r.decision.status).toBe('rejected');
  });

  it('first decision wins: a second resolution is refused and cannot flip the outcome', () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    expect(decisions.resolve(a.id, 'rejected', { channel: 'dashboard', by: 'dashboard' }).ok).toBe(true);
    const second = decisions.resolve(a.id, 'approved', { channel: 'phone', by: 'phone' });
    expect(second).toMatchObject({ ok: false, reason: 'already_resolved' });
    expect(decisions.get(a.id)!.status).toBe('rejected');
  });

  it('refuses unknown ids', () => {
    const { decisions } = setup();
    expect(decisions.resolve('dec_nope', 'approved', { channel: 'phone', by: 'x' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('expires after the timeout and can never be approved afterwards (fail closed)', () => {
    const { decisions, advance } = setup({ timeoutSeconds: 60 });
    const a = decisions.create(req()).decision;
    advance(61_000);
    const r = decisions.resolve(a.id, 'approved', { channel: 'phone', by: 'phone' });
    expect(r).toMatchObject({ ok: false, reason: 'expired' });
    expect(decisions.get(a.id)!.status).toBe('expired');
  });

  it('sweep expires overdue decisions and cancels ones whose hook stopped polling', () => {
    const { decisions, advance } = setup({ timeoutSeconds: 600, grace: 30 });
    const a = decisions.create(req()).decision;
    advance(31_000);
    decisions.sweep();
    expect(decisions.get(a.id)!.status).toBe('cancelled');

    const b = decisions.create(req({ sessionId: 'sess-C' })).decision;
    advance(10_000);
    decisions.heartbeat(b.id);
    advance(25_000);
    decisions.sweep();
    expect(decisions.get(b.id)!.status).toBe('pending');
    advance(600_000);
    decisions.sweep();
    expect(decisions.get(b.id)!.status).toBe('expired');
  });

  it('wait() resolves as soon as the decision settles', async () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    const waiting = decisions.wait(a.id, 5_000);
    decisions.resolve(a.id, 'approved', { channel: 'dashboard', by: 'dashboard' });
    expect((await waiting)!.status).toBe('approved');
  });

  it('wait() returns the pending state on timeout without resolving anything', async () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    const d = await decisions.wait(a.id, 20);
    expect(d!.status).toBe('pending');
  });

  it('records an audit trail for each transition', () => {
    const { decisions, store } = setup();
    const a = decisions.create(req()).decision;
    decisions.resolve(a.id, 'approved', { channel: 'phone', by: 'phone' });
    decisions.resolve(a.id, 'rejected', { channel: 'dashboard', by: 'dashboard' });
    const types = store.listEvents({ decisionId: a.id }).map((e) => e.type).reverse();
    expect(types).toEqual(['decision.created', 'decision.approved', 'decision.resolve_refused']);
  });

  it('a new identical request after resolution creates a fresh decision', () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    decisions.resolve(a.id, 'approved', { channel: 'phone', by: 'phone' });
    const b = decisions.create(req());
    expect(b.duplicate).toBe(false);
    expect(b.decision.id).not.toBe(a.id);
  });

  it('cancels pending decisions when the session ends', () => {
    const { decisions } = setup();
    const a = decisions.create(req()).decision;
    expect(decisions.cancelPendingForSession('sess-A', 'session ended')).toBe(1);
    expect(decisions.get(a.id)!.status).toBe('cancelled');
  });
});
