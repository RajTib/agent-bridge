import type { RiskHint } from '@agentbridge/contracts';

// Deliberately simple pattern list, not a security boundary — riskHint is a
// HINT for channel adapters (e.g. to color a Discord message), never a
// reason to skip showing the human the full command. See docs/security.md.
const HIGH_RISK_PATTERNS: RegExp[] = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /curl[^\n]*\|\s*(sh|bash)\b/i,
  /wget[^\n]*\|\s*(sh|bash)\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // classic shell fork bomb
  /\bchmod\s+777\b/i,
  /\bdrop\s+table\b/i,
  /\bmkfs\b/i,
  />\s*\/dev\/sd/i,
];

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'NotebookRead']);
const MUTATING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Best-effort guess at how dangerous a tool call looks.
 */
export function guessRiskHint(toolName: string, toolInput: Record<string, unknown>): RiskHint {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';

  if (command && HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command))) {
    return 'high';
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return 'low';
  }

  if (MUTATING_TOOLS.has(toolName) || toolName === 'Bash') {
    return 'medium';
  }

  return 'unknown';
}
