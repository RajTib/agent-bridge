import { Client, Events } from 'discord.js';
import type { Decision } from '@agentbridge/contracts';
import { parseCustomId } from './render';

export type DecisionHandler = (
  approvalId: string,
  decision: Decision,
  decidedBy: string,
  reason?: string,
) => Promise<void>;

/**
 * Wires a Discord client's button clicks to a decision handler. Ignores any
 * interaction whose customId isn't ours (see parseCustomId), so this bot can
 * coexist with other bots/components in the same server.
 *
 * After reporting the decision, edits the original message to show the
 * outcome and removes the buttons — this stops the same approval from being
 * clicked twice from the Discord side. (The real single-use guarantee still
 * lives server-side in the core relay's state machine, not here — a channel
 * adapter must never be the thing that decides an approval is final.)
 */
export function registerInteractionHandler(client: Client, handler: DecisionHandler): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return;

    try {
      await handler(parsed.approvalId, parsed.decision, interaction.user.tag);

      const verb = parsed.decision === 'approved' ? 'Approved' : 'Denied';
      await interaction.update({
        content: `**${verb}** by ${interaction.user.tag}`,
        embeds: interaction.message.embeds,
        components: [],
      });
    } catch (err) {
      console.error('agentbridge discord adapter: failed to handle button interaction', err);
    }
  });
}
