import type { Decision, DecisionStatus } from '@agentbridge/shared';
import { speakable } from '@agentbridge/core';

/**
 * Everything the automated voice says, in one place. Kept short and plain:
 * people hear this on a phone, often half-awake. Exact commands are never
 * read out; the dashboard has the full detail.
 */

export const MENU =
  'To approve this action, press 1. To reject this action, press 0. To repeat this message, press 2.';

function project(d: Decision): string {
  return speakable(d.projectName, 60) || 'your project';
}

function riskSentence(d: Decision): string {
  if (d.risk !== 'high') return '';
  const why = d.riskReasons[0] ? `: ${speakable(d.riskReasons[0], 60)}` : '';
  return ` AgentBridge rates this action as high risk${why}.`;
}

export const script = {
  intro(d: Decision): string {
    return (
      `Hello. This is AgentBridge calling on behalf of Claude Code. ` +
      `In the project ${project(d)}, Claude wants to ${d.spokenSummary}.` +
      ` It needs your approval because your Claude Code permission settings require confirmation for this action.` +
      riskSentence(d) +
      ' The full details are on your AgentBridge dashboard.'
    );
  },
  repeat(d: Decision): string {
    return `Once more. In the project ${project(d)}, Claude wants to ${d.spokenSummary}.${riskSentence(d)}`;
  },
  invalid: 'Sorry, that is not a valid option.',
  noInput: 'I did not hear a key press.',
  giveUp:
    'No valid response was received, so this action has not been approved. You can still decide on your AgentBridge dashboard. Goodbye.',
  approved: 'Approved. Claude Code will continue with this action. Goodbye.',
  rejected: 'Rejected. Claude Code will not perform this action. Goodbye.',
  expiredNow:
    'Sorry, this request expired before your answer arrived, so it was not approved. Goodbye.',
  alreadyResolved(status: DecisionStatus): string {
    const what: Record<DecisionStatus, string> = {
      approved: 'already been approved',
      rejected: 'already been rejected',
      expired: 'expired and was not approved',
      cancelled: 'been cancelled because Claude Code stopped waiting',
      pending: 'not been decided yet',
    };
    return `This request has ${what[status]}. No further action is needed. Goodbye.`;
  },
};
