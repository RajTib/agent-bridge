import type { RiskLevel } from '@agentbridge/shared';

/**
 * Best-effort risk classification. This is a HINT for prioritising and for
 * deciding whether to phone the developer -- it is never a security boundary
 * and never a reason to skip asking. Claude Code's own permission rules
 * decide whether approval is needed at all.
 */

interface Rule {
  pattern: RegExp;
  reason: string;
}

const HIGH_RISK_COMMANDS: Rule[] = [
  { pattern: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive|-r)\b/i, reason: 'recursive delete' },
  { pattern: /\bRemove-Item\b[^\n]*-Recurse/i, reason: 'recursive delete' },
  { pattern: /\b(rmdir|rd)\s+\/s\b/i, reason: 'recursive delete' },
  { pattern: /\bdel\s+\/[sq]/i, reason: 'bulk delete' },
  { pattern: /\bsudo\b/i, reason: 'elevated privileges' },
  {
    pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]*\|\s*(sh|bash|zsh|iex|Invoke-Expression|python)\b/i,
    reason: 'pipes a download into a shell',
  },
  { pattern: /\bchmod\s+(-R\s+)?777\b/i, reason: 'world-writable permissions' },
  { pattern: /\bdrop\s+(table|database|schema)\b/i, reason: 'destroys database objects' },
  { pattern: /\btruncate\s+table\b/i, reason: 'destroys database rows' },
  { pattern: /\bmkfs\b|\bformat\s+[a-z]:/i, reason: 'formats a disk' },
  { pattern: /\bdd\s+if=/i, reason: 'raw disk write' },
  { pattern: />\s*\/dev\/sd/i, reason: 'raw disk write' },
  {
    pattern: /\bgit\s+push\b[^\n]*(--force\b|\s-f\b|--force-with-lease)/i,
    reason: 'force-push rewrites remote history',
  },
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'discards local changes' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, reason: 'deletes untracked files' },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: 'force-deletes a branch' },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: 'publishes a package' },
  { pattern: /\bterraform\s+(apply|destroy)\b/i, reason: 'changes infrastructure' },
  { pattern: /\bkubectl\s+(delete|apply|drain)\b/i, reason: 'changes a cluster' },
  { pattern: /\bdocker\s+(system\s+prune|volume\s+rm|rm\s+-f)/i, reason: 'deletes containers or volumes' },
  { pattern: /\b(shutdown|reboot|halt)\b/i, reason: 'stops the machine' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb' },
  {
    pattern: /\b(cat|type|Get-Content)\b[^\n]*(\.env\b|id_rsa|\.ssh\/|credentials)/i,
    reason: 'reads secrets',
  },
  { pattern: /\bgh\s+repo\s+(delete|edit\s+[^\n]*--visibility)/i, reason: 'changes a GitHub repository' },
];

const MEDIUM_RISK_COMMANDS: Rule[] = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|i|add)\b/i, reason: 'installs dependencies' },
  { pattern: /\b(pip|pip3|poetry|cargo|go)\s+(install|add|get)\b/i, reason: 'installs dependencies' },
  { pattern: /\bgit\s+push\b/i, reason: 'publishes commits to a remote' },
  { pattern: /\b(curl|wget|Invoke-WebRequest)\b/i, reason: 'network access' },
  { pattern: /\brm\b|\bRemove-Item\b|\bdel\b/i, reason: 'deletes files' },
  { pattern: /\bdocker\b/i, reason: 'runs containers' },
];

const SENSITIVE_PATHS: Rule[] = [
  { pattern: /(^|[\\/])\.env(\.|$)/i, reason: 'touches an environment/secrets file' },
  { pattern: /(^|[\\/])\.ssh[\\/]/i, reason: 'touches SSH keys' },
  { pattern: /(^|[\\/])\.github[\\/]workflows[\\/]/i, reason: 'changes CI workflows' },
  {
    pattern: /(^|[\\/])\.claude[\\/]settings(\.local)?\.json$/i,
    reason: 'changes Claude Code permissions',
  },
  { pattern: /credentials|secrets?\.(json|ya?ml)|\.pem$|\.key$/i, reason: 'touches credentials' },
];

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'NotebookRead']);
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
}

function matchAll(rules: Rule[], text: string): string[] {
  return [...new Set(rules.filter((r) => r.pattern.test(text)).map((r) => r.reason))];
}

export function assessRisk(toolName: string, toolInput: Record<string, unknown>): RiskAssessment {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const filePath =
    typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : typeof toolInput.notebook_path === 'string'
        ? toolInput.notebook_path
        : '';

  if (command) {
    const high = matchAll(HIGH_RISK_COMMANDS, command);
    if (high.length) return { level: 'high', reasons: high };
    const medium = matchAll(MEDIUM_RISK_COMMANDS, command);
    return { level: 'medium', reasons: medium.length ? medium : ['runs a shell command'] };
  }

  if (filePath) {
    const sensitive = matchAll(SENSITIVE_PATHS, filePath);
    if (sensitive.length) return { level: 'high', reasons: sensitive };
    if (FILE_WRITE_TOOLS.has(toolName)) return { level: 'medium', reasons: ['modifies a file'] };
  }

  if (READ_ONLY_TOOLS.has(toolName)) return { level: 'low', reasons: ['read-only tool'] };
  if (toolName === 'WebFetch') return { level: 'low', reasons: ['fetches a web page'] };
  if (toolName.startsWith('mcp__')) return { level: 'medium', reasons: ['external MCP tool'] };
  return { level: 'medium', reasons: ['tool requires permission'] };
}
