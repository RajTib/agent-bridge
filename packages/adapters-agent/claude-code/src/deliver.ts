import type { ApprovalOutcome } from '@agentbridge/contracts';

export interface HookResponse {
  exitCode: number;
  /** JSON to write to stdout. Only meaningful for PreToolUse-originated approvals. */
  json?: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse';
      permissionDecision: 'allow' | 'deny' | 'ask';
      permissionDecisionReason?: string;
    };
  };
}

/**
 * Pure translation of a decided ApprovalOutcome into what Claude Code's
 * PreToolUse hook protocol expects. Kept side-effect free so it's trivially
 * unit-testable; deliverOutcome() below is the thin impure wrapper that
 * actually writes to stdout/sets the exit code.
 */
export function renderOutcome(outcome: ApprovalOutcome): HookResponse {
  const who = outcome.decidedBy ? ` by ${outcome.decidedBy}` : '';
  const via = outcome.channel ? ` via ${outcome.channel}` : ' via AgentBridge';

  switch (outcome.decision) {
    case 'approved':
      return {
        exitCode: 0,
        json: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: `Approved${via}${who}.`,
          },
        },
      };
    case 'denied':
      return {
        exitCode: 0,
        json: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: outcome.reason ?? `Denied${via}${who}.`,
          },
        },
      };
    case 'timed_out':
      // Safe fallback: hand back to Claude Code's own normal interactive
      // prompt instead of guessing. Never auto-approve on timeout.
      return {
        exitCode: 0,
        json: {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: 'No response in time — falling back to the normal prompt.',
          },
        },
      };
    default: {
      const _exhaustive: never = outcome.decision;
      throw new Error(`Unhandled decision: ${_exhaustive as string}`);
    }
  }
}

/** Impure wrapper: writes the rendered response to stdout and sets the process exit code. */
export function deliverOutcome(outcome: ApprovalOutcome): void {
  const response = renderOutcome(outcome);
  if (response.json) {
    process.stdout.write(JSON.stringify(response.json));
  }
  process.exitCode = response.exitCode;
}
