import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CallStatus, MockCallView } from '@agentbridge/shared';
import {
  firstParam,
  type IncomingWebhook,
  type OutboundCallRequest,
  type ParsedWebhook,
  type ProviderHealth,
  type TelephonyProvider,
  type VoiceAction,
  type VoiceSettings,
} from './types.js';

interface SimulatedCall {
  providerCallId: string;
  callId: string;
  to: string;
  voiceUrl: string;
  statusUrl: string;
  state: MockCallView['state'];
  transcript: string[];
  gatherUrl: string | null;
  noInputUrl: string | null;
}

export interface SignedWebhook {
  url: string;
  params: Record<string, string>;
  headers: Record<string, string>;
}

/**
 * A simulated telephony provider for development and tests.
 *
 * It places NO real phone calls. It does, however, go through exactly the same
 * webhook path as a real provider: every simulated "answer" or "key press" is
 * a signed HTTP webhook that the server verifies, parses and feeds through the
 * same call-flow engine. `isRealCall` is false and the dashboard labels these
 * calls as simulated.
 */
export class MockTelephonyProvider implements TelephonyProvider {
  readonly name = 'mock';
  readonly isRealCall = false;
  readonly requiresPublicUrl = false;
  private readonly secret = randomBytes(32);
  private readonly calls = new Map<string, SimulatedCall>();
  /** Test hook: make the next N makeCall() invocations fail (simulates carrier errors). */
  failNextCalls = 0;
  private listener: ((view: MockCallView & { decisionId?: string }) => void) | null = null;

  onChange(listener: (view: MockCallView) => void): void {
    this.listener = listener;
  }

  health(): ProviderHealth {
    return { configured: true, problems: [] };
  }

  async makeCall(req: OutboundCallRequest): Promise<{ providerCallId: string }> {
    if (this.failNextCalls > 0) {
      this.failNextCalls--;
      throw new Error('Simulated carrier failure (mock provider)');
    }
    const providerCallId = `MOCK${randomBytes(12).toString('hex')}`;
    const call: SimulatedCall = {
      providerCallId,
      callId: req.callId,
      to: req.to,
      voiceUrl: req.voiceUrl,
      statusUrl: req.statusUrl,
      state: 'ringing',
      transcript: [],
      gatherUrl: null,
      noInputUrl: null,
    };
    this.calls.set(providerCallId, call);
    this.emit(call);
    return { providerCallId };
  }

  sign(url: string, params: Record<string, string>): string {
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
    return createHmac('sha256', this.secret).update(data).digest('base64');
  }

  verifyWebhook(req: IncomingWebhook): boolean {
    const provided = firstParam(req.headers['x-mock-signature']);
    if (!provided) return false;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.params)) {
      const f = firstParam(v);
      if (f !== null) params[k] = f;
    }
    const a = Buffer.from(provided);
    const b = Buffer.from(this.sign(req.url, params));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(req: IncomingWebhook): ParsedWebhook {
    const digits = firstParam(req.params.Digits);
    const status = firstParam(req.params.CallStatus);
    return {
      providerCallId: firstParam(req.params.CallSid),
      to: firstParam(req.params.To),
      digits: digits && digits.length ? digits : null,
      callStatus: (status as CallStatus | null) ?? null,
    };
  }

  renderResponse(actions: VoiceAction[], _voice: VoiceSettings): { contentType: string; body: string } {
    return { contentType: 'application/json', body: JSON.stringify({ actions }) };
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const c = this.calls.get(providerCallId);
    if (!c) return 'failed';
    return c.state === 'ringing' ? 'ringing' : c.state === 'in_progress' ? 'in_progress' : 'completed';
  }

  async terminateCall(providerCallId: string): Promise<void> {
    const c = this.calls.get(providerCallId);
    if (!c || c.state === 'ended') return;
    c.state = 'ended';
    c.transcript.push('[call ended by AgentBridge]');
    c.gatherUrl = null;
    this.emit(c);
  }

  // ---- simulator API (used by the dashboard's simulated handset) ----------

  get(providerCallId: string): SimulatedCall | undefined {
    return this.calls.get(providerCallId);
  }

  findByCallId(callId: string): SimulatedCall | undefined {
    for (const c of this.calls.values()) if (c.callId === callId) return c;
    return undefined;
  }

  views(): MockCallView[] {
    return [...this.calls.values()].map((c) => this.view(c));
  }

  private view(c: SimulatedCall): MockCallView {
    return {
      callId: c.callId,
      decisionId: '',
      state: c.state,
      transcript: [...c.transcript],
      awaitingDigits: c.state === 'in_progress' && Boolean(c.gatherUrl),
    };
  }

  private emit(c: SimulatedCall): void {
    this.listener?.(this.view(c));
  }

  private signed(c: SimulatedCall, url: string, extra: Record<string, string>): SignedWebhook {
    const params = { CallSid: c.providerCallId, To: c.to, From: '+10000000000', ...extra };
    return { url, params, headers: { 'x-mock-signature': this.sign(url, params) } };
  }

  /** The handset picks up: returns the signed "voice" webhook to deliver. */
  answer(providerCallId: string): SignedWebhook | null {
    const c = this.calls.get(providerCallId);
    if (!c || c.state !== 'ringing') return null;
    c.state = 'in_progress';
    return this.signed(c, c.voiceUrl, { CallStatus: 'in-progress' });
  }

  press(providerCallId: string, digits: string): SignedWebhook | null {
    const c = this.calls.get(providerCallId);
    if (!c || c.state !== 'in_progress' || !c.gatherUrl) return null;
    c.transcript.push(`[you pressed ${digits}]`);
    const url = c.gatherUrl;
    c.gatherUrl = null;
    return this.signed(c, url, { Digits: digits });
  }

  /** No key pressed before the gather timeout. */
  silence(providerCallId: string): SignedWebhook | null {
    const c = this.calls.get(providerCallId);
    if (!c || c.state !== 'in_progress' || !c.noInputUrl) return null;
    c.transcript.push('[no key pressed]');
    const url = c.noInputUrl;
    c.gatherUrl = null;
    c.noInputUrl = null;
    return this.signed(c, url, {});
  }

  status(providerCallId: string, status: 'completed' | 'no-answer' | 'busy' | 'failed'): SignedWebhook | null {
    const c = this.calls.get(providerCallId);
    if (!c) return null;
    if (status !== 'completed' || c.state !== 'ended') {
      c.state = 'ended';
      c.transcript.push(status === 'completed' ? '[call ended]' : `[call ${status}]`);
      c.gatherUrl = null;
      this.emit(c);
    }
    const map: Record<string, string> = { completed: 'completed', 'no-answer': 'no_answer', busy: 'busy', failed: 'failed' };
    return this.signed(c, c.statusUrl, { CallStatus: map[status]! });
  }

  /** Feed the server's rendered response back into the simulated handset. */
  applyResponse(providerCallId: string, body: string): void {
    const c = this.calls.get(providerCallId);
    if (!c) return;
    let actions: VoiceAction[] = [];
    try {
      actions = (JSON.parse(body) as { actions: VoiceAction[] }).actions ?? [];
    } catch {
      return;
    }
    c.gatherUrl = null;
    c.noInputUrl = null;
    for (const a of actions) {
      if (a.type === 'say') c.transcript.push(a.text);
      if (a.type === 'gather') {
        c.transcript.push(...a.prompt);
        c.gatherUrl = a.actionUrl;
      }
      if (a.type === 'redirect') c.noInputUrl = a.url;
      if (a.type === 'hangup') {
        c.state = 'ended';
        c.gatherUrl = null;
        c.noInputUrl = null;
        c.transcript.push('[AgentBridge hung up]');
      }
    }
    this.emit(c);
  }
}
