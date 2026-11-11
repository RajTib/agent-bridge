import { describe, expect, it } from 'vitest';
import twilio from 'twilio';
import {
  Audit,
  DecisionService,
  EventBus,
  SessionService,
  Store,
  loadConfig,
  openDatabase,
  type AppConfig,
} from '@agentbridge/core';
import { CallManager } from './call-manager.js';
import { MockTelephonyProvider, type SignedWebhook } from './mock.js';
import { TwilioProvider, computeTwilioSignature, renderTwiml } from './twilio.js';

const TO = '+919876543210';
const flush = () => new Promise((r) => setTimeout(r, 5));

function setup(env: Record<string, string> = {}) {
  const config: AppConfig = loadConfig({
    TELEPHONY_PROVIDER: 'mock',
    PHONE_TO_NUMBER: TO,
    CALL_RETRY_DELAY_SECONDS: '0',
    ...env,
  });
  const store = new Store(openDatabase(':memory:'));
  const bus = new EventBus();
  const audit = new Audit(store, bus);
  const sessions = new SessionService(store, bus, audit);
  const decisions = new DecisionService({
    store,
    bus,
    audit,
    sessions,
    timeoutSeconds: config.approvalTimeoutSeconds,
    heartbeatGraceSeconds: 600,
  });
  const provider = new MockTelephonyProvider();
  const calls = new CallManager({
    provider,
    store,
    decisions,
    bus,
    audit,
    telephony: config.telephony,
    webhookBaseUrl: 'http://agentbridge.test',
  });
  calls.start();

  const kindOf = (url: string) => new URL(url).pathname.split('/').pop()!;
  const callIdOf = (url: string) => new URL(url).pathname.split('/')[3]!;
  async function deliver(w: SignedWebhook | null) {
    if (!w) throw new Error('simulator refused the action');
    const u = new URL(w.url);
    const res = await calls.handleWebhook('mock', callIdOf(w.url), kindOf(w.url), w, Object.fromEntries(u.searchParams));
    const call = store.getCall(callIdOf(w.url))!;
    if (res.body && call.providerCallId) provider.applyResponse(call.providerCallId, res.body);
    return res;
  }
  const createDecision = (command = 'npm install jsonwebtoken', sessionId = 's1') =>
    decisions.create({ sessionId, agent: 'claude-code', cwd: '/w/shop-api', toolName: 'Bash', toolInput: { command } })
      .decision;
  const activeCall = (decisionId: string) => store.listCalls({ decisionId })[0]!;
  return { config, store, decisions, provider, calls, deliver, createDecision, activeCall };
}

describe('Twilio signature', () => {
  const token = '12345';
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+12349013030',
    Digits: '1234',
    From: '+12349013030',
    To: '+18005551212',
  };

  it('matches the official twilio SDK implementation', () => {
    const sig = computeTwilioSignature(token, url, params);
    expect(twilio.validateRequest(token, sig, url, params)).toBe(true);
  });

  it('verifyWebhook accepts valid and rejects tampered/missing signatures', () => {
    const p = new TwilioProvider({ accountSid: `AC${'0'.repeat(32)}`, authToken: token, fromNumber: '+15005550006' });
    const sig = computeTwilioSignature(token, url, params);
    expect(p.verifyWebhook({ url, params, headers: { 'x-twilio-signature': sig } })).toBe(true);
    expect(p.verifyWebhook({ url, params: { ...params, Digits: '1' }, headers: { 'x-twilio-signature': sig } })).toBe(false);
    expect(p.verifyWebhook({ url: `${url}&x=1`, params, headers: { 'x-twilio-signature': sig } })).toBe(false);
    expect(p.verifyWebhook({ url, params, headers: {} })).toBe(false);
  });

  it('renders escaped TwiML with a DTMF gather', () => {
    const xml = renderTwiml(
      [
        { type: 'gather', prompt: ['Press 1 & <go>'], numDigits: 1, timeoutSeconds: 8, actionUrl: 'https://x/a?seq=1&b=2' },
        { type: 'hangup' },
      ],
      { voice: 'Polly.Aditi', language: 'en-IN' },
    );
    expect(xml).toContain('<Gather input="dtmf" numDigits="1" timeout="8" action="https://x/a?seq=1&amp;b=2"');
    expect(xml).toContain('Press 1 &amp; &lt;go&gt;');
    expect(xml).toContain('<Hangup/>');
  });

  it('places calls through the REST API with status callbacks', async () => {
    let captured: { url: string; body: string } | null = null;
    const p = new TwilioProvider({
      accountSid: `AC${'a'.repeat(32)}`,
      authToken: 'tok',
      fromNumber: '+15005550006',
      fetchImpl: (async (u: string, init: RequestInit) => {
        captured = { url: u, body: String(init.body) };
        return new Response(JSON.stringify({ sid: 'CAxyz' }), { status: 201 });
      }) as unknown as typeof fetch,
    });
    const r = await p.makeCall({ callId: 'call_1', to: TO, voiceUrl: 'https://p/v', statusUrl: 'https://p/s', ringTimeoutSeconds: 30 });
    expect(r.providerCallId).toBe('CAxyz');
    const form = new URLSearchParams(captured!.body);
    expect(captured!.url).toMatch(/\/2010-04-01\/Accounts\/ACa+\/Calls\.json$/);
    expect(form.get('To')).toBe(TO);
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);
  });

  it('surfaces API errors without credentials', async () => {
    const p = new TwilioProvider({
      accountSid: `AC${'a'.repeat(32)}`,
      authToken: 'super-secret-token',
      fromNumber: '+15005550006',
      fetchImpl: (async () =>
        new Response(JSON.stringify({ code: 21219, message: 'The number is unverified' }), { status: 400 })) as unknown as typeof fetch,
    });
    await expect(
      p.makeCall({ callId: 'c', to: TO, voiceUrl: 'https://p/v', statusUrl: 'https://p/s', ringTimeoutSeconds: 30 }),
    ).rejects.toThrow(/21219: The number is unverified/);
  });
});

describe('DTMF approval flow (mock provider)', () => {
  it('pressing 1 approves exactly the decision the call is about', async () => {
    const t = setup();
    const d = t.createDecision();
    const other = t.createDecision('rm -rf build', 's2');
    await flush();
    const call = t.activeCall(d.id);
    expect(call.isRealCall).toBe(false);
    expect(call.toMasked).toBe('+91******3210');

    const answer = await t.deliver(t.provider.answer(call.providerCallId!));
    expect(answer.body).toContain('Claude wants to install a new dependency called jsonwebtoken');
    expect(answer.body).toContain('press 1');

    const res = await t.deliver(t.provider.press(call.providerCallId!, '1'));
    expect(res.body).toContain('Approved.');
    await flush();
    // The confirmation must be spoken before the call ends; AgentBridge must not cut it off.
    const transcript = t.provider.get(call.providerCallId!)!.transcript;
    expect(transcript).not.toContain('[call ended by AgentBridge]');
    expect(transcript.slice(-2)).toEqual([expect.stringContaining('Approved.'), '[AgentBridge hung up]']);
    expect(t.decisions.get(d.id)!.status).toBe('approved');
    expect(t.decisions.get(d.id)!.resolutionChannel).toBe('phone');
    expect(t.decisions.get(other.id)!.status).toBe('pending');
    expect(t.store.getCall(call.id)!.result).toBe('approved');
  });

  it('pressing 0 rejects', async () => {
    const t = setup();
    const d = t.createDecision();
    await flush();
    const call = t.activeCall(d.id);
    await t.deliver(t.provider.answer(call.providerCallId!));
    const res = await t.deliver(t.provider.press(call.providerCallId!, '0'));
    expect(res.body).toContain('Rejected.');
    expect(t.decisions.get(d.id)!.status).toBe('rejected');
  });

  it('2 repeats; invalid keys re-prompt; too many invalid inputs hang up without approving', async () => {
    const t = setup({ DTMF_MAX_PROMPTS: '2' });
    const d = t.createDecision();
    await flush();
    const sid = t.activeCall(d.id).providerCallId!;
    await t.deliver(t.provider.answer(sid));
    expect((await t.deliver(t.provider.press(sid, '2'))).body).toContain('Once more');
    expect((await t.deliver(t.provider.press(sid, '7'))).body).toContain('not a valid option');
    const last = await t.deliver(t.provider.press(sid, '#'));
    expect(last.body).toContain('has not been approved');
    expect(t.decisions.get(d.id)!.status).toBe('pending');
  });

  it('a replayed key-press webhook cannot approve anything', async () => {
    const t = setup();
    const d = t.createDecision();
    await flush();
    const sid = t.activeCall(d.id).providerCallId!;
    await t.deliver(t.provider.answer(sid));
    const press0 = t.provider.press(sid, '2')!; // harmless key, captured by an "attacker"
    await t.deliver(press0);
    // Replay the same signed webhook but with digit 1: signature breaks.
    const forged = { ...press0, params: { ...press0.params, Digits: '1' } };
    expect((await t.deliver(forged)).status).toBe(403);
    // Replay the exact signed webhook: accepted signature, but stale prompt -> no state change.
    const replay = await t.deliver(press0);
    expect(replay.status).toBe(200);
    expect(t.decisions.get(d.id)!.status).toBe('pending');
  });

  it('a webhook signed for one call cannot be redirected to another call', async () => {
    const t = setup();
    const a = t.createDecision('echo a', 'sA');
    await flush();
    const sidA = t.activeCall(a.id).providerCallId!;
    await t.deliver(t.provider.answer(sidA));
    const pressA = t.provider.press(sidA, '1')!;
    const b = t.createDecision('echo b', 'sB');
    // Point A's signed key press at B's call path -> signature (URL) mismatch.
    const callB = t.store.insertCall({
      id: 'call_BBBBBBBBBBBBBBBBBBBBBB',
      decisionId: b.id,
      provider: 'mock',
      isRealCall: false,
      toMasked: 'x',
      attempt: 9,
      status: 'in_progress',
      createdAt: new Date().toISOString(),
    });
    const res = await t.calls.handleWebhook(
      'mock',
      callB.id,
      'gather',
      { ...pressA, url: pressA.url.replace(t.activeCall(a.id).id, callB.id) },
      { seq: '1' },
    );
    expect(res.status).toBe(403);
    expect(t.decisions.get(b.id)!.status).toBe('pending');
  });

  it('rejects webhooks for untrusted destination numbers and unknown calls', async () => {
    const t = setup();
    const d = t.createDecision();
    await flush();
    const call = t.activeCall(d.id);
    const w = t.provider.answer(call.providerCallId!)!;
    const params = { ...w.params, To: '+911111111111' };
    const res = await t.calls.handleWebhook('mock', call.id, 'voice', {
      url: w.url,
      params,
      headers: { 'x-mock-signature': t.provider.sign(w.url, params) },
    }, { seq: '0', reason: 'answer' });
    expect(res.status).toBe(403);
    const unknown = await t.calls.handleWebhook('mock', 'call_doesnotexist', 'voice', w, {});
    expect(unknown.status).toBe(404);
  });

  it('a key press after expiry does not approve (fail closed)', async () => {
    const t = setup();
    const d = t.createDecision();
    await flush();
    const sid = t.activeCall(d.id).providerCallId!;
    await t.deliver(t.provider.answer(sid));
    const latePress = t.provider.press(sid, '1')!; // pressed, but arrives after expiry
    t.decisions.expire(d.id);
    await flush();
    expect(t.provider.get(sid)!.state).toBe('ended'); // AgentBridge hung up on expiry
    const res = await t.deliver(latePress);
    expect(res.body).not.toContain('Approved');
    expect(t.decisions.get(d.id)!.status).toBe('expired');
  });

  it('call failures are retried and never approve', async () => {
    const t = setup({ CALL_MAX_ATTEMPTS: '2' });
    t.provider.failNextCalls = 2;
    const d = t.createDecision();
    await flush();
    await flush();
    await flush();
    const calls = t.store.listCalls({ decisionId: d.id });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.status === 'failed' && c.result === 'error')).toBe(true);
    expect(t.decisions.get(d.id)!.status).toBe('pending');
  });

  it('no-answer status triggers a retry; the decision stays pending', async () => {
    const t = setup({ CALL_MAX_ATTEMPTS: '2' });
    const d = t.createDecision();
    await flush();
    const first = t.activeCall(d.id);
    await t.deliver(t.provider.status(first.providerCallId!, 'no-answer'));
    await flush();
    const all = t.store.listCalls({ decisionId: d.id });
    expect(all).toHaveLength(2);
    expect(t.store.getCall(first.id)!.status).toBe('no_answer');
    expect(t.decisions.get(d.id)!.status).toBe('pending');
  });

  it('silence re-prompts and eventually gives up without approving', async () => {
    const t = setup({ DTMF_MAX_PROMPTS: '2' });
    const d = t.createDecision();
    await flush();
    const sid = t.activeCall(d.id).providerCallId!;
    await t.deliver(t.provider.answer(sid));
    expect((await t.deliver(t.provider.silence(sid))).body).toContain('did not hear');
    expect((await t.deliver(t.provider.silence(sid))).body).toContain('has not been approved');
    expect(t.decisions.get(d.id)!.status).toBe('pending');
  });

  it('a dashboard decision hangs up the active call', async () => {
    const t = setup();
    const d = t.createDecision();
    await flush();
    const call = t.activeCall(d.id);
    t.decisions.resolve(d.id, 'rejected', { channel: 'dashboard', by: 'dashboard' });
    await flush();
    const after = t.store.getCall(call.id)!;
    expect(after.status).toBe('canceled');
    expect(after.result).toBe('superseded');
    expect(t.provider.get(call.providerCallId!)!.state).toBe('ended');
  });

  it('calls one decision at a time and moves on when the first settles', async () => {
    const t = setup();
    const a = t.createDecision('echo a', 'sA');
    const b = t.createDecision('echo b', 'sB');
    await flush();
    expect(t.store.listCalls({ decisionId: b.id })).toHaveLength(0);
    const sidA = t.activeCall(a.id).providerCallId!;
    await t.deliver(t.provider.answer(sidA));
    await t.deliver(t.provider.press(sidA, '1'));
    await t.deliver(t.provider.status(sidA, 'completed'));
    await flush();
    expect(t.store.listCalls({ decisionId: b.id })).toHaveLength(1);
  });

  it('respects CALL_MIN_RISK', async () => {
    const t = setup({ CALL_MIN_RISK: 'high' });
    const d = t.createDecision('npm install left-pad');
    await flush();
    expect(t.store.listCalls({ decisionId: d.id })).toHaveLength(0);
    const h = t.createDecision('rm -rf /tmp/x', 's9');
    await flush();
    expect(t.store.listCalls({ decisionId: h.id })).toHaveLength(1);
  });

  it('reports real providers as disabled until a public URL and credentials exist', () => {
    const t = setup();
    const p = new TwilioProvider({ accountSid: null, authToken: null, fromNumber: null });
    const m = new CallManager({
      provider: p,
      store: t.store,
      decisions: t.decisions,
      bus: new EventBus(),
      audit: new Audit(t.store, new EventBus()),
      telephony: t.config.telephony,
      webhookBaseUrl: null,
    });
    const s = m.status();
    expect(s.enabled).toBe(false);
    expect(s.isRealCall).toBe(true);
    expect(s.problems.join(' ')).toMatch(/AGENTBRIDGE_PUBLIC_URL/);
  });
});
