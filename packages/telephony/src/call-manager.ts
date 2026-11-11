import {
  RISK_ORDER,
  TERMINAL_CALL_STATUSES,
  maskPhone,
  type CallStatus,
  type Decision,
  type ProviderStatus,
} from '@agentbridge/shared';
import { newId, type AppConfig, type Audit, type CallRow, type DecisionService, type EventBus, type Store } from '@agentbridge/core';
import { MENU, script } from './voice-script.js';
import type { IncomingWebhook, TelephonyProvider, VoiceAction, WebhookKind } from './types.js';

export interface CallManagerOptions {
  provider: TelephonyProvider | null;
  store: Store;
  decisions: DecisionService;
  bus: EventBus;
  audit: Audit;
  telephony: AppConfig['telephony'];
  /** Base URL the provider uses to reach our webhooks (public URL for real providers). */
  webhookBaseUrl: string | null;
  now?: () => Date;
}

export interface WebhookResult {
  status: number;
  contentType?: string;
  body?: string;
}

/**
 * Orchestrates approval phone calls:
 *  - queues one call per pending decision (one active call at a time)
 *  - drives the DTMF dialogue (1 approve, 0 reject, 2 repeat, else re-prompt)
 *  - retries unanswered/failed calls up to CALL_MAX_ATTEMPTS
 *  - hangs up when the decision is settled elsewhere (dashboard, timeout)
 *
 * Webhook trust model: a webhook is only acted on when (1) the provider
 * signature is valid, (2) the call id in the URL exists and belongs to this
 * provider, (3) the provider's call id matches the one we placed, (4) the
 * dialled number is a trusted number, and (5) the prompt sequence number is
 * the one currently outstanding and has not been consumed before. A replayed
 * or forged webhook can therefore never approve a different -- or a later --
 * action: each call is bound to exactly one decision id.
 */
export class CallManager {
  private readonly queue: string[] = [];
  private activeCallId: string | null = null;
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private readonly now: () => Date;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly o: CallManagerOptions) {
    this.now = o.now ?? (() => new Date());
  }

  start(): void {
    // Calls left open by a previous server process: their webhooks still work (state
    // is in SQLite), but close them if no terminal status arrives soon.
    for (const c of this.o.store.listCalls({ limit: 500 })) {
      if (!TERMINAL_CALL_STATUSES.includes(c.status)) {
        this.watch(c.id, 60_000, 'failed', 'call was open when the server restarted');
      }
    }
    this.unsubscribers.push(
      this.o.bus.on('decision.created', (d) => this.onDecisionCreated(d)),
      this.o.bus.on('decision.resolved', (d) => {
        void this.onDecisionResolved(d);
      }),
    );
  }

  stop(): void {
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
  }

  get provider(): TelephonyProvider | null {
    return this.o.provider;
  }

  status(): ProviderStatus {
    const p = this.o.provider;
    const t = this.o.telephony;
    const problems: string[] = [];
    if (!p) {
      return {
        name: 'none',
        isRealCall: false,
        configured: false,
        enabled: false,
        publicUrl: this.o.webhookBaseUrl,
        toMasked: t.toNumber ? maskPhone(t.toNumber) : null,
        problems: ['Phone calls disabled (TELEPHONY_PROVIDER=none)'],
      };
    }
    problems.push(...p.health().problems);
    if (!t.toNumber) problems.push('PHONE_TO_NUMBER is not set');
    if (p.requiresPublicUrl && !this.o.webhookBaseUrl) {
      problems.push('AGENTBRIDGE_PUBLIC_URL is not set (the provider cannot reach the DTMF webhooks)');
    }
    return {
      name: p.name,
      isRealCall: p.isRealCall,
      configured: p.health().configured,
      enabled: problems.length === 0,
      publicUrl: this.o.webhookBaseUrl,
      toMasked: t.toNumber ? maskPhone(t.toNumber) : null,
      problems,
    };
  }

  private canCall(): boolean {
    return this.status().enabled;
  }

  // ---- queueing --------------------------------------------------------

  private onDecisionCreated(d: Decision): void {
    if (!this.canCall()) return;
    if (RISK_ORDER[d.risk] < RISK_ORDER[this.o.telephony.minRisk]) {
      this.o.audit.record({
        type: 'call.queued',
        decisionId: d.id,
        sessionId: d.sessionId,
        message: `No call: risk ${d.risk} is below CALL_MIN_RISK=${this.o.telephony.minRisk} (decide on the dashboard)`,
      });
      return;
    }
    this.enqueue(d.id, 'auto');
  }

  /** Manual "call me about this" from the dashboard. Returns false if nothing was queued. */
  requestCall(decisionId: string): { ok: boolean; reason?: string } {
    const d = this.o.decisions.get(decisionId);
    if (!d || d.status !== 'pending') return { ok: false, reason: 'decision is not pending' };
    if (!this.canCall()) return { ok: false, reason: 'phone calls are not configured' };
    const active = this.activeCallId ? this.o.store.getCall(this.activeCallId) : null;
    if (active?.decisionId === decisionId || this.queue.includes(decisionId)) {
      return { ok: false, reason: 'a call for this decision is already in progress or queued' };
    }
    this.enqueue(decisionId, 'manual');
    return { ok: true };
  }

  private enqueue(decisionId: string, why: 'auto' | 'manual' | 'retry', front = false): void {
    if (this.queue.includes(decisionId)) return;
    if (front) this.queue.unshift(decisionId);
    else this.queue.push(decisionId);
    if (why !== 'retry') {
      const d = this.o.decisions.get(decisionId);
      this.o.audit.record({
        type: 'call.queued',
        decisionId,
        sessionId: d?.sessionId ?? null,
        message: why === 'manual' ? 'Phone call requested from the dashboard' : 'Phone call queued',
      });
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.activeCallId) return;
    while (this.queue.length) {
      const decisionId = this.queue.shift()!;
      const d = this.o.decisions.get(decisionId);
      if (!d || d.status !== 'pending') continue;
      const attempt = this.o.store.listCalls({ decisionId, limit: 50 }).length + 1;
      await this.placeCall(d, attempt);
      return;
    }
  }

  private url(callId: string, kind: WebhookKind, query: Record<string, string | number> = {}): string {
    const q = new URLSearchParams(
      Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
    return `${this.o.webhookBaseUrl}/telephony/${this.o.provider!.name}/${callId}/${kind}${q ? `?${q}` : ''}`;
  }

  private async placeCall(d: Decision, attempt: number): Promise<void> {
    const provider = this.o.provider!;
    const to = this.o.telephony.toNumber!;
    if (!this.o.telephony.trustedNumbers.includes(to)) {
      // Defence in depth: config validation already enforces this.
      this.o.audit.record({ type: 'call.failed', level: 'error', decisionId: d.id, message: 'Refusing to call an untrusted number' });
      return;
    }
    const call = this.o.store.insertCall({
      id: newId('call'),
      decisionId: d.id,
      provider: provider.name,
      isRealCall: provider.isRealCall,
      toMasked: maskPhone(to),
      attempt,
      status: 'initiating',
      createdAt: this.now().toISOString(),
    });
    this.activeCallId = call.id;
    this.o.bus.emit('call', call);

    try {
      const { providerCallId } = await provider.makeCall({
        callId: call.id,
        to,
        voiceUrl: this.url(call.id, 'voice', { seq: 0, reason: 'answer' }),
        statusUrl: this.url(call.id, 'status'),
        ringTimeoutSeconds: this.o.telephony.ringTimeoutSeconds,
      });
      const latest = this.o.store.getCall(call.id);
      // A status webhook may already have advanced the call; only fill in what's missing.
      const updated = this.o.store.updateCall(call.id, {
        providerCallId,
        status: latest && latest.status !== 'initiating' ? latest.status : 'ringing',
      })!;
      this.o.bus.emit('call', updated);
      // Upper bound on a call's lifetime: ring time plus a generous conversation window.
      this.watch(call.id, (this.o.telephony.ringTimeoutSeconds + 600) * 1000, 'failed', 'no terminal status from provider');
      this.o.audit.record({
        type: 'call.initiated',
        decisionId: d.id,
        sessionId: d.sessionId,
        callId: call.id,
        message: `${provider.isRealCall ? 'Calling' : 'SIMULATED call (mock provider, no real phone call) to'} ${call.toMasked} (attempt ${attempt}/${this.o.telephony.maxAttempts})`,
        data: { provider: provider.name, isRealCall: provider.isRealCall, attempt },
      });
      // If the decision settled while we were dialling, hang up immediately.
      const now = this.o.decisions.get(d.id);
      if (now && now.status !== 'pending') await this.onDecisionResolved(now);
    } catch (err) {
      // Provider errors can echo the destination number; mask any phone numbers.
      const message = (err as Error).message.replace(/\+?\d[\d\s-]{7,16}\d/g, (m) => maskPhone(m)).slice(0, 300);
      const failed = this.o.store.updateCall(call.id, {
        status: 'failed',
        result: 'error',
        error: message,
        endedAt: this.now().toISOString(),
      })!;
      this.o.bus.emit('call', failed);
      this.o.audit.record({
        type: 'call.failed',
        level: 'error',
        decisionId: d.id,
        sessionId: d.sessionId,
        callId: call.id,
        message: `Call could not be placed: ${message}. The action remains NOT approved.`,
      });
      this.finish(call.id);
    }
  }

  /** Called whenever a call reaches a terminal state. Schedules a retry if it achieved nothing. */
  private finish(callId: string): void {
    const call = this.o.store.getCall(callId);
    if (this.activeCallId === callId) this.activeCallId = null;
    if (call) {
      const d = this.o.decisions.get(call.decisionId);
      const decided = call.result === 'approved' || call.result === 'rejected';
      if (d && d.status === 'pending' && !decided && call.attempt < this.o.telephony.maxAttempts) {
        const delay = this.o.telephony.retryDelaySeconds * 1000;
        const timer = setTimeout(() => {
          this.retryTimers.delete(d.id);
          this.enqueue(d.id, 'retry', true);
        }, delay);
        timer.unref();
        this.retryTimers.set(d.id, timer);
        this.o.audit.record({
          type: 'call.queued',
          decisionId: d.id,
          sessionId: d.sessionId,
          message: `Will retry the call in ${this.o.telephony.retryDelaySeconds}s (attempt ${call.attempt + 1}/${this.o.telephony.maxAttempts})`,
        });
      }
    }
    void this.pump();
  }

  private async onDecisionResolved(d: Decision): Promise<void> {
    const qi = this.queue.indexOf(d.id);
    if (qi >= 0) this.queue.splice(qi, 1);
    const t = this.retryTimers.get(d.id);
    if (t) {
      clearTimeout(t);
      this.retryTimers.delete(d.id);
    }
    if (!this.activeCallId) return;
    const call = this.o.store.getCall(this.activeCallId);
    if (!call || call.decisionId !== d.id || TERMINAL_CALL_STATUSES.includes(call.status)) return;
    // Only the active call can resolve via phone; it speaks the confirmation and hangs up itself.
    if (d.resolutionChannel === 'phone') return;
    // Decided elsewhere (dashboard/timeout/cancel): stop ringing the developer.
    const updated = this.o.store.updateCall(call.id, { result: 'superseded' })!;
    this.o.bus.emit('call', updated);
    if (call.providerCallId) {
      try {
        await this.o.provider!.terminateCall(call.providerCallId);
      } catch (err) {
        this.o.audit.record({
          type: 'call.status',
          level: 'warn',
          callId: call.id,
          decisionId: d.id,
          message: `Could not hang up superseded call: ${(err as Error).message.slice(0, 200)}`,
        });
      }
    }
    const ended = this.o.store.updateCall(call.id, { status: 'canceled', endedAt: this.now().toISOString() })!;
    this.o.bus.emit('call', ended);
    this.finish(call.id);
  }

  // ---- webhooks --------------------------------------------------------

  async handleWebhook(
    providerName: string,
    callId: string,
    kind: string,
    req: IncomingWebhook,
    query: Record<string, string | undefined>,
  ): Promise<WebhookResult> {
    const provider = this.o.provider;
    const reject = (status: number, why: string): WebhookResult => {
      this.o.audit.record({
        type: 'webhook.rejected',
        level: 'warn',
        callId: /^call_[A-Za-z0-9_-]{22}$/.test(callId) ? callId : null,
        message: `Rejected ${providerName}/${kind} webhook: ${why}`,
      });
      return { status, body: 'rejected' };
    };

    if (!provider || provider.name !== providerName) return reject(404, 'provider not active');
    if (kind !== 'voice' && kind !== 'gather' && kind !== 'status') return reject(404, 'unknown webhook kind');
    if (!provider.verifyWebhook(req)) return reject(403, 'invalid signature');

    const call = this.o.store.getCall(callId);
    if (!call || call.provider !== provider.name) return reject(404, 'unknown call');

    const parsed = provider.parseWebhook(req);
    if (call.providerCallId && parsed.providerCallId !== call.providerCallId) {
      return reject(403, 'provider call id mismatch');
    }
    if (parsed.to && !this.o.telephony.trustedNumbers.includes(parsed.to)) {
      return reject(403, 'destination is not a trusted number');
    }

    if (kind === 'status') {
      this.applyStatus(call, parsed.callStatus);
      return { status: 204 };
    }

    const actions = kind === 'voice' ? this.onVoice(call, query) : this.onGather(call, query, parsed.digits);
    const rendered = provider.renderResponse(actions, {
      voice: this.o.telephony.voice,
      language: this.o.telephony.language,
    });
    return { status: 200, contentType: rendered.contentType, body: rendered.body };
  }

  private applyStatus(call: CallRow, status: CallStatus | null): void {
    if (!status || TERMINAL_CALL_STATUSES.includes(call.status)) return;
    const terminal = TERMINAL_CALL_STATUSES.includes(status);
    const patch: Parameters<Store['updateCall']>[1] = { status };
    if (status === 'in_progress' && !call.answeredAt) patch.answeredAt = this.now().toISOString();
    if (terminal) {
      patch.endedAt = this.now().toISOString();
      if (!call.result) patch.result = call.answeredAt ? 'no_response' : status === 'completed' ? 'no_response' : 'error';
    }
    const updated = this.o.store.updateCall(call.id, patch)!;
    this.o.bus.emit('call', updated);
    const d = this.o.decisions.get(call.decisionId);
    this.o.audit.record({
      type: terminal ? (status === 'completed' ? 'call.ended' : 'call.failed') : 'call.status',
      level: terminal && status !== 'completed' ? 'warn' : 'info',
      decisionId: call.decisionId,
      sessionId: d?.sessionId ?? null,
      callId: call.id,
      message: `Call ${status.replace('_', ' ')}${terminal && updated.result ? ` (${updated.result.replace('_', ' ')})` : ''}`,
    });
    if (terminal) this.finish(call.id);
  }

  private gatherPrompt(call: CallRow, lines: string[]): VoiceAction[] {
    const seq = call.promptSeq + 1;
    const updated = this.o.store.updateCall(call.id, { promptSeq: seq, promptsPlayed: call.promptsPlayed + 1 });
    if (updated) this.o.bus.emit('call', updated);
    return [
      {
        type: 'gather',
        prompt: [...lines, MENU],
        numDigits: 1,
        timeoutSeconds: this.o.telephony.dtmfInputTimeoutSeconds,
        actionUrl: this.url(call.id, 'gather', { seq }),
      },
      { type: 'redirect', url: this.url(call.id, 'voice', { seq, reason: 'noinput' }) },
    ];
  }

  private end(call: CallRow, text: string, result: CallRow['result']): VoiceAction[] {
    const latest = this.o.store.getCall(call.id);
    if (result && latest && !latest.result) {
      const updated = this.o.store.updateCall(call.id, { result })!;
      this.o.bus.emit('call', updated);
    }
    // We are hanging up. The provider's final status callback normally closes the
    // call; if it never arrives (e.g. tunnel hiccup), don't let the queue stall.
    this.watch(call.id, 30_000, 'completed', 'hung up by AgentBridge; no final status callback received');
    return [{ type: 'say', text }, { type: 'hangup' }];
  }

  /** Force-closes a call that never reports a terminal status, so the queue keeps moving. */
  private watch(callId: string, ms: number, status: CallStatus, note: string): void {
    const timer = setTimeout(() => {
      const c = this.o.store.getCall(callId);
      if (!c || TERMINAL_CALL_STATUSES.includes(c.status)) return;
      const updated = this.o.store.updateCall(callId, {
        status,
        endedAt: this.now().toISOString(),
        result: c.result ?? 'no_response',
        error: c.error ?? note,
      })!;
      this.o.bus.emit('call', updated);
      this.o.audit.record({
        type: 'call.ended',
        level: 'warn',
        callId,
        decisionId: c.decisionId,
        message: `Call closed by watchdog: ${note}`,
      });
      this.finish(callId);
    }, ms);
    timer.unref();
  }

  private onVoice(call: CallRow, query: Record<string, string | undefined>): VoiceAction[] {
    if (TERMINAL_CALL_STATUSES.includes(call.status)) return [{ type: 'hangup' }];
    const d = this.o.decisions.get(call.decisionId)!;
    const reason = query.reason === 'noinput' ? 'noinput' : 'answer';
    const seq = Number(query.seq ?? -1);

    if (!call.answeredAt) {
      const updated = this.o.store.updateCall(call.id, {
        status: 'in_progress',
        answeredAt: this.now().toISOString(),
      })!;
      this.o.bus.emit('call', updated);
      this.o.audit.record({
        type: 'call.answered',
        decisionId: d.id,
        sessionId: d.sessionId,
        callId: call.id,
        message: `${call.isRealCall ? 'Call' : 'Simulated call'} answered`,
      });
      call = updated;
    }

    if (d.status !== 'pending') return this.end(call, script.alreadyResolved(d.status), 'superseded');

    const claimed = this.o.store.claimWebhookKey(`${call.id}:${reason}:${seq}`, this.now().toISOString());
    if (!claimed || (reason === 'noinput' && seq !== call.promptSeq)) {
      // Replay or stale redirect: repeat the outstanding prompt without changing any state.
      return this.repeatCurrent(call, d);
    }

    if (reason === 'answer') return this.gatherPrompt(call, [script.intro(d)]);

    const misses = call.invalidInputs + 1;
    this.o.store.updateCall(call.id, { invalidInputs: misses });
    if (misses >= this.o.telephony.dtmfMaxPrompts) return this.end(call, script.giveUp, 'no_response');
    return this.gatherPrompt({ ...call, invalidInputs: misses }, [script.noInput]);
  }

  private repeatCurrent(call: CallRow, d: Decision): VoiceAction[] {
    return [
      {
        type: 'gather',
        prompt: [script.repeat(d), MENU],
        numDigits: 1,
        timeoutSeconds: this.o.telephony.dtmfInputTimeoutSeconds,
        actionUrl: this.url(call.id, 'gather', { seq: call.promptSeq }),
      },
      { type: 'redirect', url: this.url(call.id, 'voice', { seq: call.promptSeq, reason: 'noinput' }) },
    ];
  }

  private onGather(
    call: CallRow,
    query: Record<string, string | undefined>,
    digits: string | null,
  ): VoiceAction[] {
    if (TERMINAL_CALL_STATUSES.includes(call.status)) return [{ type: 'hangup' }];
    const d = this.o.decisions.get(call.decisionId)!;
    const seq = Number(query.seq ?? -1);

    // Only the currently outstanding prompt may be answered, and only once.
    const fresh =
      Number.isInteger(seq) &&
      seq === call.promptSeq &&
      this.o.store.claimWebhookKey(`${call.id}:gather:${seq}`, this.now().toISOString());
    if (!fresh) {
      this.o.audit.record({
        type: 'webhook.rejected',
        level: 'warn',
        callId: call.id,
        decisionId: d.id,
        message: `Ignored replayed or stale key press (prompt ${seq}, current ${call.promptSeq})`,
      });
      if (d.status !== 'pending') return this.end(call, script.alreadyResolved(d.status), null);
      return this.repeatCurrent(call, d);
    }

    const key = (digits ?? '').trim().charAt(0);
    this.o.audit.record({
      type: 'call.digits',
      decisionId: d.id,
      sessionId: d.sessionId,
      callId: call.id,
      message: key ? `Caller pressed ${key}` : 'No key pressed',
    });

    if (d.status !== 'pending') return this.end(call, script.alreadyResolved(d.status), 'superseded');

    if (key === '1' || key === '0') {
      const outcome = key === '1' ? 'approved' : 'rejected';
      const res = this.o.decisions.resolve(d.id, outcome, {
        channel: 'phone',
        by: call.isRealCall ? `phone ${call.toMasked}` : 'simulated phone (mock provider, dashboard user)',
        callId: call.id,
        note: `Keypad ${key} on ${call.isRealCall ? 'phone call' : 'simulated call'} ${call.id}`,
      });
      if (res.ok) return this.end(call, outcome === 'approved' ? script.approved : script.rejected, outcome);
      if (res.reason === 'expired') return this.end(call, script.expiredNow, 'no_response');
      return this.end(call, script.alreadyResolved(res.decision?.status ?? 'expired'), 'superseded');
    }

    if (key === '2') {
      if (call.promptsPlayed >= this.o.telephony.dtmfMaxPrompts * 2) {
        return this.end(call, script.giveUp, 'no_response');
      }
      return this.gatherPrompt(call, [script.repeat(d)]);
    }

    const misses = call.invalidInputs + 1;
    this.o.store.updateCall(call.id, { invalidInputs: misses });
    if (misses >= this.o.telephony.dtmfMaxPrompts) return this.end(call, script.giveUp, 'no_response');
    return this.gatherPrompt({ ...call, invalidInputs: misses }, [script.invalid]);
  }
}
