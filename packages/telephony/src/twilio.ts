import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CallStatus } from '@agentbridge/shared';
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

/**
 * Twilio Programmable Voice, implemented directly against the documented REST
 * API and TwiML (no SDK dependency):
 *  - POST /2010-04-01/Accounts/{Sid}/Calls.json to place the call
 *  - <Gather input="dtmf"> + <Say> to speak and collect a key press
 *  - X-Twilio-Signature (HMAC-SHA1 over URL + sorted POST params) on every webhook
 */

export interface TwilioOptions {
  accountSid: string | null;
  authToken: string | null;
  fromNumber: string | null;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

const STATUS_MAP: Record<string, CallStatus> = {
  queued: 'queued',
  initiated: 'initiating',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  failed: 'failed',
  'no-answer': 'no_answer',
  canceled: 'canceled',
};

export function mapTwilioStatus(s: string | null): CallStatus | null {
  return s ? (STATUS_MAP[s] ?? null) : null;
}

/** Twilio's documented webhook signature algorithm. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string | string[] | undefined>,
): string {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) data += key + item;
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function renderTwiml(actions: VoiceAction[], voice: VoiceSettings): string {
  const sayAttrs = `voice="${escapeXml(voice.voice)}" language="${escapeXml(voice.language)}"`;
  const say = (t: string) => `<Say ${sayAttrs}>${escapeXml(t)}</Say>`;
  const parts = actions.map((a) => {
    switch (a.type) {
      case 'say':
        return say(a.text);
      case 'pause':
        return `<Pause length="${Math.max(1, Math.round(a.seconds))}"/>`;
      case 'gather':
        return (
          `<Gather input="dtmf" numDigits="${a.numDigits}" timeout="${a.timeoutSeconds}" ` +
          `action="${escapeXml(a.actionUrl)}" method="POST" actionOnEmptyResult="false">` +
          a.prompt.map(say).join('') +
          `</Gather>`
        );
      case 'redirect':
        return `<Redirect method="POST">${escapeXml(a.url)}</Redirect>`;
      case 'hangup':
        return '<Hangup/>';
    }
  });
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join('')}</Response>`;
}

export class TwilioProvider implements TelephonyProvider {
  readonly name = 'twilio';
  readonly isRealCall = true;
  readonly requiresPublicUrl = true;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: TwilioOptions) {
    this.apiBase = (o.apiBase ?? 'https://api.twilio.com').replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  health(): ProviderHealth {
    const problems: string[] = [];
    if (!this.o.accountSid || !/^AC[0-9a-fA-F]{32}$/.test(this.o.accountSid)) {
      problems.push('TWILIO_ACCOUNT_SID missing or malformed (expected AC + 32 hex chars)');
    }
    if (!this.o.authToken) problems.push('TWILIO_AUTH_TOKEN missing');
    if (!this.o.fromNumber) problems.push('TWILIO_FROM_NUMBER missing');
    return { configured: problems.length === 0, problems };
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64')}`;
  }

  private async api(method: 'GET' | 'POST', path: string, form?: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.apiBase}/2010-04-01/Accounts/${this.o.accountSid}${path}`, {
      method,
      headers: {
        authorization: this.authHeader(),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form?.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Twilio error bodies contain code/message/more_info -- never credentials.
      const code = json.code ?? res.status;
      const message = typeof json.message === 'string' ? json.message : res.statusText;
      throw new Error(`Twilio API error ${code}: ${message}`);
    }
    return json;
  }

  async makeCall(req: OutboundCallRequest): Promise<{ providerCallId: string }> {
    const h = this.health();
    if (!h.configured) throw new Error(`Twilio is not configured: ${h.problems.join('; ')}`);
    const form = new URLSearchParams({
      To: req.to,
      From: this.o.fromNumber!,
      Url: req.voiceUrl,
      Method: 'POST',
      StatusCallback: req.statusUrl,
      StatusCallbackMethod: 'POST',
      Timeout: String(req.ringTimeoutSeconds),
    });
    for (const e of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', e);
    const json = await this.api('POST', '/Calls.json', form);
    if (typeof json.sid !== 'string') throw new Error('Twilio API returned no call sid');
    return { providerCallId: json.sid };
  }

  verifyWebhook(req: IncomingWebhook): boolean {
    if (!this.o.authToken) return false;
    const provided = firstParam(req.headers['x-twilio-signature']);
    if (!provided) return false;
    const expected = computeTwilioSignature(this.o.authToken, req.url, req.params);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(req: IncomingWebhook): ParsedWebhook {
    const digits = firstParam(req.params.Digits);
    return {
      providerCallId: firstParam(req.params.CallSid),
      to: firstParam(req.params.To),
      digits: digits && digits.length > 0 ? digits : null,
      callStatus: mapTwilioStatus(firstParam(req.params.CallStatus)),
    };
  }

  renderResponse(actions: VoiceAction[], voice: VoiceSettings): { contentType: string; body: string } {
    return { contentType: 'text/xml; charset=utf-8', body: renderTwiml(actions, voice) };
  }

  async getCallStatus(providerCallId: string): Promise<CallStatus> {
    const json = await this.api('GET', `/Calls/${encodeURIComponent(providerCallId)}.json`);
    return mapTwilioStatus(typeof json.status === 'string' ? json.status : null) ?? 'failed';
  }

  async terminateCall(providerCallId: string): Promise<void> {
    await this.api(
      'POST',
      `/Calls/${encodeURIComponent(providerCallId)}.json`,
      new URLSearchParams({ Status: 'completed' }),
    );
  }
}
