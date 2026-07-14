import { TextChannel, Events } from 'discord.js';
import type { ChannelAdapter, PendingApproval } from '@agentbridge/contracts';
import { createDiscordClient } from './bot';
import { renderApproval } from './render';
import { registerInteractionHandler, type DecisionHandler } from './interactions';

export * from './render';
export * from './bot';
export * from './interactions';

export interface DiscordChannelAdapterConfig {
  token: string;
  /** Channel AgentBridge posts approval requests to. A future version could
   * route per-agent/per-event to different channels via config instead. */
  defaultChannelId: string;
}

export function createDiscordChannelAdapter(config: DiscordChannelAdapterConfig): ChannelAdapter {
  const client = createDiscordClient();
  let decisionHandler: DecisionHandler | undefined;
  let ready: Promise<void> | undefined;

  // Registered once at construction time — onDecision() below only ever
  // swaps out which handler this dispatches to.
  registerInteractionHandler(client, async (approvalId, decision, decidedBy, reason) => {
    if (decisionHandler) {
      await decisionHandler(approvalId, decision, decidedBy, reason);
    }
  });

  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = new Promise((resolve, reject) => {
        client.once(Events.ClientReady, () => resolve());
        client.login(config.token).catch(reject);
      });
    }
    return ready;
  }

  return {
    name: 'discord',

    async send(approval: PendingApproval): Promise<void> {
      await ensureReady();
      const channel = await client.channels.fetch(config.defaultChannelId);
      if (!channel || !(channel instanceof TextChannel)) {
        throw new Error(
          `Discord channel ${config.defaultChannelId} is not a text channel AgentBridge can post to.`,
        );
      }
      const { embeds, components, files } = renderApproval(approval);
      await channel.send({ embeds, components, files });
    },

    onDecision(handler: DecisionHandler): void {
      decisionHandler = handler;
    },
  };
}
