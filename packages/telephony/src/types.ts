import type { CallStatus } from '@agentbridge/shared';

/**
 * Provider-neutral call script. The call flow engine decides WHAT to say and
 * collect; each provider only renders it (TwiML for Twilio, JSON for mock).
 */
export type VoiceAction =
  | { type: 'say'; text: string }
  | {
      type: 'gather';
      /** Spoken while waiting for a key press (barge-in allowed). */
      prompt: string[];
      numDigits: number;
      timeoutSeconds: number;
      /** Where the provider POSTs the pressed digits. */
      actionUrl: string;
    }
  | { type: 'redirect'; url: string }
  | { type: 'pause'; seconds: number }
  | { type: 'hangup' };

export interface VoiceSettings {
  voice: string;
  language: string;
}

export interface OutboundCallRequest {
  callId: string;
  to: string;
  /** Webhook the provider fetches when the call is answered. */
  voiceUrl: string;
  /** Webhook for carrier status changes (ringing, completed, no-answer, ...). */
  statusUrl: string;
  ringTimeoutSeconds: number;
}

export type WebhookKind = 'voice' | 'gather' | 'status';

/** A raw webhook as received over HTTP, before any trust is established. */
export interface IncomingWebhook {
  /** The exact absolute URL the provider requested (what it signed). */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | string[] | undefined>;
}

export interface ParsedWebhook {
  providerCallId: string | null;
  to: string | null;
  digits: string | null;
  callStatus: CallStatus | null;
}

export interface ProviderHealth {
  configured: boolean;
  problems: string[];
}

/**
 * Contract every telephony provider implements. Mapping to the operations in
 * the design brief:
 *   makeCall()              -> makeCall
 *   handleIncomingWebhook() -> verifyWebhook + parseWebhook
 *   collectDigits()         -> renderResponse([{ type: 'gather', ... }])
 *   getCallStatus()         -> getCallStatus
 *   terminateCall()         -> terminateCall
 */
export interface TelephonyProvider {
  readonly name: string;
  /** False for simulated providers. The UI must never present a mock call as a real one. */
  readonly isRealCall: boolean;
  /** Whether webhooks must arrive via a public HTTPS URL. */
  readonly requiresPublicUrl: boolean;

  health(): ProviderHealth;
  makeCall(req: OutboundCallRequest): Promise<{ providerCallId: string }>;
  /** Constant-time signature check. MUST return false for anything unsigned or tampered. */
  verifyWebhook(req: IncomingWebhook): boolean;
  parseWebhook(req: IncomingWebhook): ParsedWebhook;
  renderResponse(actions: VoiceAction[], voice: VoiceSettings): { contentType: string; body: string };
  getCallStatus(providerCallId: string): Promise<CallStatus>;
  terminateCall(providerCallId: string): Promise<void>;
}

export function firstParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}
