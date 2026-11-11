import type { AuditEvent, AuditEventType } from '@agentbridge/shared';

/**
 * Optional Discord webhook notifications. Discord is a secondary,
 * notification-only channel: nothing received from Discord can approve
 * anything.
 */

export type DiscordKind =
  | 'session_started'
  | 'task_completed'
  | 'approval_required'
  | 'call_initiated'
  | 'decision_received'
  | 'task_failed'
  | 'agent_disconnected';

export const ALL_DISCORD_KINDS: DiscordKind[] = [
  'session_started',
  'task_completed',
  'approval_required',
  'call_initiated',
  'decision_received',
  'task_failed',
  'agent_disconnected',
];

const KIND_BY_EVENT: Partial<Record<AuditEventType, DiscordKind>> = {
  'session.started': 'session_started',
  'task.completed': 'task_completed',
  'decision.created': 'approval_required',
  'call.initiated': 'call_initiated',
  'decision.approved': 'decision_received',
  'decision.rejected': 'decision_received',
  'decision.expired': 'decision_received',
  'task.failed': 'task_failed',
  'session.ended': 'agent_disconnected',
  'decision.cancelled': 'agent_disconnected',
};

const STYLE: Record<DiscordKind, { title: string; color: number }> = {
  session_started: { title: 'Claude session started', color: 0x5865f2 },
  task_completed: { title: 'Task completed', color: 0x3ba55c },
  approval_required: { title: 'Approval required', color: 0xfaa61a },
  call_initiated: { title: 'Phone call initiated', color: 0x00b0f4 },
  decision_received: { title: 'Decision received', color: 0x9b59b6 },
  task_failed: { title: 'Task failed', color: 0xed4245 },
  agent_disconnected: { title: 'Agent disconnected', color: 0x747f8d },
};

export interface DiscordPayload {
  username: string;
  allowed_mentions: { parse: never[] };
  embeds: {
    title: string;
    description: string;
    color: number;
    timestamp: string;
    footer?: { text: string };
  }[];
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Neutralises markdown/mention tricks coming from agent-controlled text. */
function sanitize(s: string): string {
  return s.replace(/@(everyone|here)/gi, '@​$1').replace(/<@[!&]?\d+>/g, '[mention]');
}

export function discordKindFor(event: AuditEvent): DiscordKind | null {
  return KIND_BY_EVENT[event.type] ?? null;
}

export function buildDiscordPayload(event: AuditEvent): DiscordPayload | null {
  const kind = discordKindFor(event);
  if (!kind) return null;
  const style = STYLE[kind];
  let title = style.title;
  if (event.type === 'decision.approved') title = 'Decision received: approved';
  if (event.type === 'decision.rejected') title = 'Decision received: rejected';
  if (event.type === 'decision.expired') title = 'Decision timed out (not approved)';
  const ids = [event.sessionId && `session ${event.sessionId.slice(0, 8)}`, event.decisionId]
    .filter(Boolean)
    .join(' · ');
  return {
    username: 'AgentBridge',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title,
        description: truncate(sanitize(event.message), 3500),
        color: style.color,
        timestamp: event.ts,
        ...(ids ? { footer: { text: truncate(ids, 200) } } : {}),
      },
    ],
  };
}

export interface DiscordNotifierOptions {
  webhookUrl: string;
  kinds: DiscordKind[] | null;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/** Serialised, rate-limit-aware sender. Failures are logged, never thrown. */
export class DiscordNotifier {
  private readonly queue: DiscordPayload[] = [];
  private sending = false;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (msg: string) => void;
  sent = 0;
  failed = 0;

  constructor(private readonly o: DiscordNotifierOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.log = o.log ?? ((m) => console.warn(`[agentbridge:discord] ${m}`));
  }

  handle(event: AuditEvent): void {
    const kind = discordKindFor(event);
    if (!kind || (this.o.kinds && !this.o.kinds.includes(kind))) return;
    const payload = buildDiscordPayload(event);
    if (!payload) return;
    if (this.queue.length >= 100) this.queue.shift(); // bounded: drop oldest
    this.queue.push(payload);
    void this.drain();
  }

  async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const payload = this.queue[0]!;
        const ok = await this.send(payload);
        this.queue.shift();
        if (ok) this.sent++;
        else this.failed++;
      }
    } finally {
      this.sending = false;
    }
  }

  private async send(payload: DiscordPayload, attempt = 1): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.o.webhookUrl}?wait=false`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 && attempt <= 3) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const waitMs = Math.min(Math.ceil((body.retry_after ?? 1) * 1000), 10_000);
        await new Promise((r) => setTimeout(r, waitMs));
        return this.send(payload, attempt + 1);
      }
      if (!res.ok) {
        this.log(`webhook returned HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.log(`webhook request failed: ${(err as Error).message}`);
      return false;
    }
  }
}
