/**
 * The one normalized shape every AgentAdapter produces, regardless of which
 * underlying tool (Claude Code, Codex, ...) raised the event.
 */

export type EventType =
  | 'permission_required'
  | 'input_required'
  | 'run_completed'
  | 'run_failed';

export type RiskHint = 'low' | 'medium' | 'high' | 'unknown';

export interface NormalizedEvent {
  /** Adapter name that produced this event, e.g. "claude-code". */
  agent: string;

  /** The agent's own session identifier, for correlating multiple events. */
  sessionId: string;

  eventType: EventType;

  /** One-line, human-readable description — used in notification previews. */
  summary: string;

  /**
   * The full command, diff, or tool-call payload behind this event.
   * MUST be the complete, untruncated context. Channel adapters render this
   * in full on the actual approve/deny surface (see docs/security.md).
   */
  fullContext: string;

  riskHint: RiskHint;

  /** ISO 8601 timestamp of when the underlying agent raised the event. */
  timestamp: string;

  /** Adapter-specific extras (tool name, cwd, etc.) that don't fit the common shape. */
  metadata?: Record<string, unknown>;
}
