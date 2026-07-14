/**
 * Raw payload shapes Claude Code sends to a hook command via stdin.
 *
 * These are best-effort, based on Claude Code's public hooks reference as of
 * mid-2026. We only read the fields we actually need and tolerate unknown
 * extra fields, so a minor schema change upstream shouldn't break us outright
 * — but if Anthropic changes hook_event_name values or drops a field we rely
 * on, normalize() below will need updating. See docs/security.md and the
 * "6. Event System" note in the project's Obsidian journal for context.
 */

export interface ClaudeCodeHookBase {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: 'PreToolUse' | 'Notification' | 'Stop' | string;
}

/** Fires before Claude Code runs a tool. The only hook event that can gate execution. */
export interface PreToolUsePayload extends ClaudeCodeHookBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  permission_mode?: string;
}

/** Fires when Claude Code wants the human's attention (e.g. idle, waiting). Informational only — cannot block. */
export interface NotificationPayload extends ClaudeCodeHookBase {
  hook_event_name: 'Notification';
  message?: string;
}

/** Fires when Claude Code finishes responding. Informational only — cannot block. */
export interface StopPayload extends ClaudeCodeHookBase {
  hook_event_name: 'Stop';
  stop_hook_active?: boolean;
}

export type ClaudeCodeHookPayload = PreToolUsePayload | NotificationPayload | StopPayload;
