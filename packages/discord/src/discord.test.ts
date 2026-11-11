import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '@agentbridge/shared';
import { DiscordNotifier, buildDiscordPayload } from './index.js';

const ev = (over: Partial<AuditEvent>): AuditEvent => ({
  id: 1,
  ts: '2026-11-11T10:00:00.000Z',
  type: 'decision.created',
  level: 'info',
  sessionId: 'abcdef123456',
  decisionId: 'dec_x',
  callId: null,
  message: 'Approval required: Bash: npm install jsonwebtoken',
  data: null,
  ...over,
});

describe('Discord payloads', () => {
  it('maps lifecycle events to notifications', () => {
    expect(buildDiscordPayload(ev({}))!.embeds[0]!.title).toBe('Approval required');
    expect(buildDiscordPayload(ev({ type: 'call.initiated' }))!.embeds[0]!.title).toBe('Phone call initiated');
    expect(buildDiscordPayload(ev({ type: 'decision.approved' }))!.embeds[0]!.title).toMatch(/approved/);
    expect(buildDiscordPayload(ev({ type: 'task.failed' }))!.embeds[0]!.title).toBe('Task failed');
    expect(buildDiscordPayload(ev({ type: 'session.ended' }))!.embeds[0]!.title).toBe('Agent disconnected');
    expect(buildDiscordPayload(ev({ type: 'call.digits' }))).toBeNull();
  });

  it('disables mentions and neutralises @everyone in agent-controlled text', () => {
    const p = buildDiscordPayload(ev({ message: 'run echo @everyone <@123>' }))!;
    expect(p.allowed_mentions).toEqual({ parse: [] });
    expect(p.embeds[0]!.description).not.toContain('@everyone');
    expect(p.embeds[0]!.description).toContain('[mention]');
  });
});

describe('DiscordNotifier', () => {
  it('filters by kind, posts, and retries once on 429', async () => {
    const calls: string[] = [];
    let first = true;
    const n = new DiscordNotifier({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      kinds: ['approval_required'],
      log: () => {},
      fetchImpl: (async (_u: string, init: RequestInit) => {
        calls.push(String(init.body));
        if (first) {
          first = false;
          return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 });
        }
        return new Response(null, { status: 204 });
      }) as unknown as typeof fetch,
    });
    n.handle(ev({ type: 'task.completed' }));
    n.handle(ev({}));
    await n.drain();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(2);
    expect(n.sent).toBe(1);
  });

  it('never throws when Discord is unreachable', async () => {
    const n = new DiscordNotifier({
      webhookUrl: 'https://discord.com/api/webhooks/1/abc',
      kinds: null,
      log: () => {},
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    n.handle(ev({}));
    await new Promise((r) => setTimeout(r, 20));
    expect(n.failed).toBe(1);
  });
});
