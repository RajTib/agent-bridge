/**
 * Shared domain types for AgentBridge. Everything that crosses a package
 * boundary (server <-> dashboard, server <-> hook client, core <-> telephony)
 * is defined here so there is exactly one source of truth.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

export type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/** Terminal statuses. Only `approved` ever allows an action to proceed. */
export const TERMINAL_STATUSES: readonly DecisionStatus[] = [
  'approved',
  'rejected',
  'expired',
  'cancelled',
];

export type ResolutionChannel = 'phone' | 'dashboard' | 'system';

export interface Decision {
  id: string;
  sessionId: string;
  agent: string;
  projectName: string;
  cwd: string | null;
  toolName: string;
  /** One-line human summary for lists and notifications. */
  summary: string;
  /** Short, TTS-friendly sentence fragment: "install a new dependency called jsonwebtoken". */
  spokenSummary: string;
  /** Full (secret-redacted) tool input, rendered for the dashboard detail view. */
  detail: string;
  risk: RiskLevel;
  riskReasons: string[];
  status: DecisionStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionChannel: ResolutionChannel | null;
  resolutionNote: string | null;
  /** Last time the waiting hook process polled for this decision. */
  lastHeartbeatAt: string;
}

export type SessionStatus = 'active' | 'ended';

export interface AgentSession {
  id: string;
  agent: string;
  projectName: string;
  cwd: string | null;
  model: string | null;
  status: SessionStatus;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export type CallStatus =
  | 'queued'
  | 'initiating'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'
  | 'canceled';

export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = [
  'completed',
  'failed',
  'no_answer',
  'busy',
  'canceled',
];

/** What the phone call achieved, independent of the carrier-level status. */
export type CallResult = 'approved' | 'rejected' | 'no_response' | 'superseded' | 'error';

export interface PhoneCall {
  id: string;
  decisionId: string;
  provider: string;
  /** True only for providers that place real PSTN calls. Mock calls are always false. */
  isRealCall: boolean;
  providerCallId: string | null;
  toMasked: string;
  attempt: number;
  status: CallStatus;
  result: CallResult | null;
  promptsPlayed: number;
  invalidInputs: number;
  error: string | null;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
}

export type AuditEventType =
  | 'session.started'
  | 'session.ended'
  | 'agent.notification'
  | 'task.completed'
  | 'task.failed'
  | 'decision.created'
  | 'decision.duplicate'
  | 'decision.approved'
  | 'decision.rejected'
  | 'decision.expired'
  | 'decision.cancelled'
  | 'decision.resolve_refused'
  | 'call.queued'
  | 'call.initiated'
  | 'call.status'
  | 'call.answered'
  | 'call.digits'
  | 'call.failed'
  | 'call.ended'
  | 'webhook.rejected'
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'server.started';

export interface AuditEvent {
  id: number;
  ts: string;
  type: AuditEventType;
  level: 'info' | 'warn' | 'error';
  sessionId: string | null;
  decisionId: string | null;
  callId: string | null;
  message: string;
  data: Record<string, unknown> | null;
}

export interface CallStats {
  total: number;
  answered: number;
  approved: number;
  rejected: number;
  noResponse: number;
  failed: number;
}

export interface ProviderStatus {
  name: string;
  isRealCall: boolean;
  configured: boolean;
  enabled: boolean;
  publicUrl: string | null;
  toMasked: string | null;
  problems: string[];
}

/** Non-secret config the dashboard may display. Never include tokens or full phone numbers. */
export interface PublicConfigSummary {
  approvalTimeoutSeconds: number;
  timeoutBehavior: 'ask' | 'deny';
  callMinRisk: RiskLevel;
  callMaxAttempts: number;
  dtmfMaxPrompts: number;
  ringTimeoutSeconds: number;
  voice: string;
  language: string;
}

export interface Overview {
  serverStartedAt: string;
  version: string;
  pendingCount: number;
  activeSessions: number;
  decisionCounts: Record<DecisionStatus, number>;
  callStats: CallStats;
  provider: ProviderStatus;
  discordEnabled: boolean;
  config: PublicConfigSummary;
}

/** The simulated handset state shown in the dashboard when the mock provider is active. */
export interface MockCallView {
  callId: string;
  decisionId: string;
  state: 'ringing' | 'in_progress' | 'ended';
  /** What the automated voice "said", most recent last. */
  transcript: string[];
  awaitingDigits: boolean;
}

/** Server-sent event envelope pushed to the dashboard. */
export type LiveMessage =
  | { kind: 'decision'; decision: Decision }
  | { kind: 'session'; session: AgentSession }
  | { kind: 'call'; call: PhoneCall }
  | { kind: 'event'; event: AuditEvent }
  | { kind: 'mock-call'; mock: MockCallView };

/** Hook client <-> server contract. */
export interface HookDecisionResponse {
  decisionId: string;
  status: DecisionStatus;
  expiresAt: string;
  /** Set when this request was matched to an already-pending identical decision. */
  duplicate?: boolean;
  resolutionNote?: string | null;
  resolutionChannel?: ResolutionChannel | null;
}

export const DEFAULT_PORT = 4317;
export const CSRF_HEADER = 'x-agentbridge-csrf';

/** "+919876543210" -> "+91******3210". Used everywhere a number is displayed or logged. */
export function maskPhone(e164: string): string {
  const cleaned = e164.replace(/[^\d+]/g, '');
  if (cleaned.length <= 6) return '****';
  return `${cleaned.slice(0, 3)}${'*'.repeat(cleaned.length - 7)}${cleaned.slice(-4)}`;
}

export function isTerminalStatus(status: DecisionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
