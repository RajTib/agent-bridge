import type { NormalizedEvent } from '@agentbridge/contracts';
import type {
  ClaudeCodeHookPayload,
  NotificationPayload,
  PreToolUsePayload,
  StopPayload,
} from './types';
import { guessRiskHint } from './risk';

const AGENT_NAME = 'claude-code';

function isPreToolUse(p: ClaudeCodeHookPayload): p is PreToolUsePayload {
  return p.hook_event_name === 'PreToolUse';
}
function isNotification(p: ClaudeCodeHookPayload): p is NotificationPayload {
  return p.hook_event_name === 'Notification';
}
function isStop(p: ClaudeCodeHookPayload): p is StopPayload {
  return p.hook_event_name === 'Stop';
}

/** Renders the tool call as a human-readable string. Never truncated — see docs/security.md (GhostApproval). */
function renderFullContext(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof toolInput.command === 'string') {
    return toolInput.command;
  }
  return JSON.stringify(toolInput, null, 2);
}

/** Short preview only — NEVER used as fullContext, just for notification-style summaries. */
function summarize(text: string, maxLength = 120): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

/**
 * Turns a raw Claude Code hook payload (parsed JSON from stdin) into the
 * shared NormalizedEvent shape.
 *
 * Known limitation: Claude Code's Stop hook doesn't currently give us a
 * clean signal to distinguish a successful turn from a failed one, so every
 * Stop event normalizes to `run_completed`. Detecting `run_failed` would
 * mean parsing the session transcript file, which is more fragile than this
 * adapter should be for the MVP — flagged here rather than faked.
 */
export function normalize(rawPayload: unknown): NormalizedEvent {
  if (typeof rawPayload !== 'object' || rawPayload === null || !('hook_event_name' in rawPayload)) {
    throw new Error('Not a recognizable Claude Code hook payload: missing "hook_event_name"');
  }

  const payload = rawPayload as ClaudeCodeHookPayload;
  const timestamp = new Date().toISOString();

  if (isPreToolUse(payload)) {
    const fullContext = renderFullContext(payload.tool_name, payload.tool_input);
    return {
      agent: AGENT_NAME,
      sessionId: payload.session_id,
      eventType: 'permission_required',
      summary: `${payload.tool_name}: ${summarize(fullContext)}`,
      fullContext,
      riskHint: guessRiskHint(payload.tool_name, payload.tool_input),
      timestamp,
      metadata: {
        toolName: payload.tool_name,
        cwd: payload.cwd,
        transcriptPath: payload.transcript_path,
      },
    };
  }

  if (isNotification(payload)) {
    const message = payload.message ?? 'Claude Code needs your attention.';
    return {
      agent: AGENT_NAME,
      sessionId: payload.session_id,
      eventType: 'input_required',
      summary: summarize(message),
      fullContext: message,
      riskHint: 'unknown',
      timestamp,
      metadata: { cwd: payload.cwd, transcriptPath: payload.transcript_path },
    };
  }

  if (isStop(payload)) {
    return {
      agent: AGENT_NAME,
      sessionId: payload.session_id,
      eventType: 'run_completed',
      summary: 'Claude Code finished responding.',
      fullContext: `Session ${payload.session_id} finished. Transcript: ${payload.transcript_path ?? 'unknown'}`,
      riskHint: 'unknown',
      timestamp,
      metadata: { cwd: payload.cwd, transcriptPath: payload.transcript_path },
    };
  }

  throw new Error(
    `Unrecognized Claude Code hook event: "${(rawPayload as { hook_event_name: string }).hook_event_name}"`,
  );
}
