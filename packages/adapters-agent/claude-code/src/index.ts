import type { AgentAdapter, ApprovalOutcome, NormalizedEvent } from '@agentbridge/contracts';
import { normalize } from './normalize';
import { deliverOutcome } from './deliver';

export { normalize } from './normalize';
export { renderOutcome, deliverOutcome } from './deliver';
export type { HookResponse } from './deliver';
export { installHooks, mergeHooksIntoSettings } from './install';
export type { ClaudeCodeSettings, HookCommand, HookGroup } from './install';
export { guessRiskHint } from './risk';
export * from './types';

export const claudeCodeAdapter: AgentAdapter = {
  name: 'claude-code',
  normalize(rawPayload: unknown): NormalizedEvent {
    return normalize(rawPayload);
  },
  deliverOutcome(outcome: ApprovalOutcome): void {
    deliverOutcome(outcome);
  },
};
