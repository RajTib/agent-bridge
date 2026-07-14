import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';
import type { Decision, PendingApproval, RiskHint } from '@agentbridge/contracts';

const RISK_COLOR: Record<RiskHint, number> = {
  low: 0x2ecc71, // green
  medium: 0xf1c40f, // yellow
  high: 0xe74c3c, // red
  unknown: 0x95a5a6, // grey
};

const CUSTOM_ID_PREFIX = 'agentbridge';
// Discord embed field values cap at 1024 chars. We NEVER truncate
// fullContext to fit (see docs/security.md — GhostApproval); anything that
// doesn't fit inline gets attached as a plain text file instead, so the
// human always sees the complete, unabridged command/diff.
const EMBED_FIELD_LIMIT = 1024;

export function approveCustomId(approvalId: string): string {
  return `${CUSTOM_ID_PREFIX}:approve:${approvalId}`;
}

export function denyCustomId(approvalId: string): string {
  return `${CUSTOM_ID_PREFIX}:deny:${approvalId}`;
}

export interface ParsedCustomId {
  decision: Extract<Decision, 'approved' | 'denied'>;
  approvalId: string;
}

/** Returns null for any customId that isn't ours — lets this bot coexist with other bots/components. */
export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(':');
  if (parts.length !== 3 || parts[0] !== CUSTOM_ID_PREFIX) return null;
  const action = parts[1];
  const approvalId = parts[2];
  if (action === 'approve' && approvalId) return { decision: 'approved', approvalId };
  if (action === 'deny' && approvalId) return { decision: 'denied', approvalId };
  return null;
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

export interface RenderedApproval {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  files: AttachmentBuilder[];
}

/**
 * Renders a PendingApproval as a Discord message. Pure function — builds
 * discord.js payload objects but never talks to the network, so this is
 * fully unit-testable without a real bot connection.
 */
export function renderApproval(approval: PendingApproval): RenderedApproval {
  const { event } = approval;
  const color = RISK_COLOR[event.riskHint] ?? RISK_COLOR.unknown;
  const fencedContext = fenced(event.fullContext);
  const fitsInline = fencedContext.length <= EMBED_FIELD_LIMIT;

  const files: AttachmentBuilder[] = fitsInline
    ? []
    : [new AttachmentBuilder(Buffer.from(event.fullContext, 'utf-8'), { name: 'full-context.txt' })];

  const embed = new EmbedBuilder()
    .setTitle(`${event.agent} needs your decision`)
    .setDescription(event.summary)
    .addFields(
      {
        name: 'Full command / context',
        value: fitsInline
          ? fencedContext
          : '⚠️ Too long to show inline — see the attached file below. The full, unabridged content is never cut off.',
      },
      { name: 'Risk', value: event.riskHint, inline: true },
      { name: 'Session', value: event.sessionId, inline: true },
    )
    .setColor(color)
    .setFooter({ text: `Expires ${approval.expiresAt}` })
    .setTimestamp(new Date(event.timestamp));

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(approveCustomId(approval.id))
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(denyCustomId(approval.id)).setLabel('Deny').setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row], files };
}
