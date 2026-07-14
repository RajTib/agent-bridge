import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Minimal intents: we only ever post messages and react to button
 * interactions in guilds we've been invited to. We deliberately don't
 * request MessageContent or GuildMessages — we never read arbitrary
 * channel messages, only our own approval prompts and their button clicks.
 */
export function createDiscordClient(): Client {
  return new Client({ intents: [GatewayIntentBits.Guilds] });
}
