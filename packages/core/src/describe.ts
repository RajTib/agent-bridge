/**
 * Turns a raw tool invocation into three renderings:
 *  - summary: one line for lists and Discord
 *  - spoken: a short, TTS-friendly phrase that completes "Claude wants to ..."
 *  - detail: the full (secret-redacted) input for the dashboard
 *
 * Long commands are NEVER read aloud; the voice says what kind of action it
 * is and points to the dashboard for the exact text.
 */

export interface ActionDescription {
  summary: string;
  spoken: string;
  detail: string;
}

const MAX_DETAIL_CHARS = 200_000;
const MAX_SPOKEN_CHARS = 170;

const SECRET_PATTERNS: [RegExp, string][] = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  ],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g, '$1 [REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bsk-(ant-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED API KEY]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED JWT]'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/(--?(?:password|passwd|pass|token|secret|api-?key|access-?key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]'],
  [/(\b(?:mysql|mysqldump|mariadb)\b[^\n]*?\s-p)(?=[^\s-])\S+/g, '$1[REDACTED]'],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"'&;,}]+)/gi,
    '$1$2[REDACTED]',
  ],
];

/** Removes obvious credentials before anything is stored, displayed or sent anywhere. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function oneLine(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Makes text safe and pleasant for text-to-speech. */
export function speakable(text: string, max = MAX_SPOKEN_CHARS): string {
  let s = text
    .replace(/&&/g, ' and ')
    .replace(/@/g, ' at ')
    .replace(/[`*_#<>{}[\]|\\^~$]/g, ' ')
    .replace(/[^\p{L}\p{N}\s.,'":;/()+=-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    s = s.slice(0, max);
    const cut = s.lastIndexOf(' ');
    if (cut > max * 0.6) s = s.slice(0, cut);
  }
  return s;
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Shell syntax that chains, substitutes or redirects -- a benign prefix could hide anything after it. */
export function isCompoundCommand(command: string): boolean {
  return /[;&|`<>\n]|\$\(/.test(command.trim());
}

function describeShell(command: string, description: string | undefined): string {
  const cmd = command.trim();

  if (isCompoundCommand(cmd)) {
    // Never summarise only the first part of a chained command, and never present
    // the model-written description as fact: the human must read the real thing.
    const program = basename(cmd.split(/\s+/)[0] ?? 'a program');
    const said = description?.trim() ? ` Claude describes it as: ${description.trim().replace(/\.$/, '')}.` : '';
    return `run a compound shell command starting with ${program}. Please review the full command on your dashboard before approving.${said}`;
  }

  const install = cmd.match(/^(npm|pnpm|yarn|bun)\s+(?:install|i|add)\b([^;&|\n]*)/i);
  if (install) {
    const pkgs = (install[2] ?? '')
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-'))
      .map((p) => p.replace(/(.)@[^@/]*$/, '$1'))
      .slice(0, 4);
    if (pkgs.length === 0) return "install the project's dependencies";
    return pkgs.length === 1
      ? `install a new dependency called ${pkgs[0]}`
      : `install new dependencies called ${listWords(pkgs)}`;
  }
  const pip = cmd.match(/^(?:pip3?|uv\s+pip|python\s+-m\s+pip)\s+install\s+([^;&|\n]*)/i);
  if (pip) {
    const pkgs = (pip[1] ?? '')
      .split(/\s+/)
      .filter((t) => t && !t.startsWith('-'))
      .slice(0, 4);
    return pkgs.length ? `install the Python package ${listWords(pkgs)}` : 'install Python packages';
  }
  if (/^git\s+push\b/i.test(cmd)) {
    return /--force|\s-f\b/.test(cmd)
      ? 'force push to the remote Git repository, which rewrites its history'
      : 'push commits to the remote Git repository';
  }
  if (/^git\s+commit\b/i.test(cmd)) return 'create a Git commit';
  if (/^git\s+reset\s+--hard\b/i.test(cmd)) {
    return 'hard reset the Git repository, discarding local changes';
  }
  if (/^(rm|del|Remove-Item)\b/i.test(cmd) && !/[;&|]/.test(cmd)) {
    const targets = cmd
      .split(/\s+/)
      .slice(1)
      .filter((t) => t && !t.startsWith('-'))
      .map(basename)
      .slice(0, 3);
    return targets.length ? `delete ${listWords(targets)}` : 'delete files';
  }
  if (cmd.length <= 60 && !/\$/.test(cmd)) return `run the shell command ${cmd}`;
  const program = basename(cmd.split(/\s+/)[0] ?? 'a program');
  const said = description?.trim() ? `. Claude describes it as: ${description.trim().replace(/\.$/, '')}` : '';
  return `run a shell command using ${program}${said}`;
}

export function describeAction(toolName: string, input: Record<string, unknown>): ActionDescription {
  const str = (k: string): string | undefined =>
    typeof input[k] === 'string' ? (input[k] as string) : undefined;
  let spoken: string;
  let summary: string;
  let detail: string;

  if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = str('command') ?? '';
    const description = str('description');
    spoken = describeShell(command, description);
    summary = `${toolName}: ${redactSecrets(command)}`;
    detail = `$ ${command}${description ? `\n\n# ${description}` : ''}`;
  } else if (toolName === 'Write') {
    const path = str('file_path') ?? 'a file';
    spoken = `create or overwrite the file ${basename(path)}`;
    summary = `Write ${path}`;
    detail = `File: ${path}\n\n${str('content') ?? ''}`;
  } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const path = str('file_path') ?? 'a file';
    spoken = `edit the file ${basename(path)}`;
    summary = `${toolName} ${path}`;
    detail = `File: ${path}\n\n${JSON.stringify(input, null, 2)}`;
  } else if (toolName === 'NotebookEdit') {
    const path = str('notebook_path') ?? 'a notebook';
    spoken = `edit the notebook ${basename(path)}`;
    summary = `NotebookEdit ${path}`;
    detail = JSON.stringify(input, null, 2);
  } else if (toolName === 'WebFetch') {
    const url = str('url') ?? '';
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch {
      /* keep the raw value */
    }
    spoken = `fetch a web page from ${host}`;
    summary = `WebFetch ${url}`;
    detail = JSON.stringify(input, null, 2);
  } else if (toolName === 'WebSearch') {
    const q = str('query') ?? '';
    spoken = `search the web for ${q}`;
    summary = `WebSearch "${oneLine(q, 100)}"`;
    detail = JSON.stringify(input, null, 2);
  } else if (toolName.startsWith('mcp__')) {
    const [, server = 'an external', tool = 'a'] = toolName.split('__');
    spoken = `use the ${tool.replace(/[_-]+/g, ' ')} tool from the ${server.replace(/[_-]+/g, ' ')} integration`;
    summary = `${server} > ${tool}`;
    detail = JSON.stringify(input, null, 2);
  } else if (toolName === 'Task' || toolName === 'Agent') {
    const what = str('description');
    spoken = `start a sub agent${what ? ` to ${what}` : ''}`;
    summary = `${toolName}: ${oneLine(what ?? str('prompt') ?? '')}`;
    detail = JSON.stringify(input, null, 2);
  } else {
    spoken = `use the ${toolName} tool`;
    summary = `${toolName}: ${JSON.stringify(input).slice(0, 5000)}`;
    detail = JSON.stringify(input, null, 2);
  }

  detail = redactSecrets(detail);
  if (detail.length > MAX_DETAIL_CHARS) {
    const extra = detail.length - MAX_DETAIL_CHARS;
    detail = `${detail.slice(0, MAX_DETAIL_CHARS)}\n\n[... ${extra} more characters not stored]`;
  }
  // Redact BEFORE truncating so a cut-off secret can't slip past a pattern.
  return {
    summary: oneLine(redactSecrets(summary), 200),
    spoken: speakable(redactSecrets(spoken), MAX_SPOKEN_CHARS + 120),
    detail,
  };
}
