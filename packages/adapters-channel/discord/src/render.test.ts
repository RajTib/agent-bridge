import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '@agentbridge/contracts';
import { approveCustomId, denyCustomId, parseCustomId, renderApproval } from './render';

function makeApproval(fullContext: string): PendingApproval {
  return {
    id: 'appr-1',
    token: 'sig.token.here',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    event: {
      agent: 'claude-code',
      sessionId: 'sess-1',
      eventType: 'permission_required',
      summary: 'Bash: rm -rf ./build',
      fullContext,
      riskHint: 'high',
      timestamp: new Date().toISOString(),
    },
  };
}

describe('renderApproval', () => {
  it('embeds short fullContext inline, with no attachment', () => {
    const rendered = renderApproval(makeApproval('rm -rf ./build'));
    const field = rendered.embeds[0]!.toJSON().fields?.find((f) => f.name.includes('Full command'));
    expect(field?.value).toContain('rm -rf ./build');
    expect(rendered.files).toHaveLength(0);
  });

  it('never truncates a long fullContext — moves it to an attachment instead', () => {
    const longContext = 'echo hello '.repeat(200); // well over the 1024-char embed field limit
    const rendered = renderApproval(makeApproval(longContext));

    expect(rendered.files).toHaveLength(1);
    const attachedText = Buffer.from(rendered.files[0]!.attachment as Buffer).toString('utf-8');
    expect(attachedText).toBe(longContext); // byte-identical, never cut off

    const field2 = rendered.embeds[0]!.toJSON().fields?.find((f) => f.name.includes('Full command'));
    expect(field2?.value).not.toContain(longContext);
    expect(field2?.value).toContain('attached file');
  });

  it('creates Approve/Deny buttons with the correct custom IDs', () => {
    const rendered = renderApproval(makeApproval('ls'));
    const row = rendered.components[0]!.toJSON();
    const customIds = row.components.map((c) => ('custom_id' in c ? c.custom_id : undefined));
    expect(customIds).toContain(approveCustomId('appr-1'));
    expect(customIds).toContain(denyCustomId('appr-1'));
  });

  it('colors the embed by risk hint', () => {
    const low = renderApproval({ ...makeApproval('ls'), event: { ...makeApproval('ls').event, riskHint: 'low' } });
    const high = renderApproval(makeApproval('rm -rf /'));
    expect(low.embeds[0]!.toJSON().color).not.toBe(high.embeds[0]!.toJSON().color);
  });
});

describe('parseCustomId', () => {
  it('parses an approve id', () => {
    expect(parseCustomId(approveCustomId('abc-123'))).toEqual({ decision: 'approved', approvalId: 'abc-123' });
  });

  it('parses a deny id', () => {
    expect(parseCustomId(denyCustomId('abc-123'))).toEqual({ decision: 'denied', approvalId: 'abc-123' });
  });

  it('returns null for custom IDs belonging to some other bot/component', () => {
    expect(parseCustomId('someOtherBot:action:xyz')).toBeNull();
    expect(parseCustomId('not-even-colons')).toBeNull();
    expect(parseCustomId('agentbridge:maybe:extra:parts')).toBeNull();
  });
});
