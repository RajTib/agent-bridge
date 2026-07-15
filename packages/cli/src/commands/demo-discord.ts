import { randomUUID } from 'node:crypto';
import { createDiscordChannelAdapter } from '@agentbridge/adapter-discord';
import type { PendingApproval } from '@agentbridge/contracts';

const DEMO_TIMEOUT_MS = 5 * 60_000;
// Gives registerInteractionHandler's own await interaction.update() time to
// finish (it runs right after our onDecision callback resolves, on a
// separate async chain driven by discord.js's event emitter) before we tear
// the process down. Exiting too early is exactly what caused Discord's
// "The application didn't respond in time" error during testing.
const SHUTDOWN_GRACE_MS = 1500;

/**
 * Live, manual test for the Discord channel adapter — sends one fake
 * approval request to a real Discord channel and waits for a real human to
 * click Approve or Deny. There's no core relay yet (step 5), so this talks
 * to the adapter directly instead of going through a relay.
 */
export async function runDemoDiscord(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_CHANNEL_ID;

  if (!token || !channelId) {
    console.error(
      [
        'Missing DISCORD_BOT_TOKEN / DISCORD_CHANNEL_ID.',
        'Put them in a .env file at the repo root, then run:',
        '  node --env-file=.env packages/cli/dist/index.js demo discord',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }

  const adapter = createDiscordChannelAdapter({ token, defaultChannelId: channelId });

  const approval: PendingApproval = {
    id: randomUUID(),
    token: 'demo-token-not-a-real-signed-token',
    expiresAt: new Date(Date.now() + DEMO_TIMEOUT_MS).toISOString(),
    event: {
      agent: 'claude-code',
      sessionId: 'demo-session',
      eventType: 'permission_required',
      summary: 'Bash: rm -rf ./build  (DEMO — nothing will actually run)',
      fullContext: 'rm -rf ./build',
      riskHint: 'high',
      timestamp: new Date().toISOString(),
    },
  };

  let markDecided: (() => void) | undefined;
  const whenDecided = new Promise<void>((resolve) => {
    markDecided = resolve;
  });

  adapter.onDecision(async (approvalId, decision, decidedBy) => {
    console.log(`Received decision: ${decision} by ${decidedBy} (approvalId ${approvalId})`);
    markDecided?.();
  });

  console.log('Sending a demo approval request to Discord — go click Approve or Deny there...');
  await adapter.send(approval);

  const timedOut = await Promise.race([
    whenDecided.then(() => false as const),
    new Promise<true>((resolve) => setTimeout(() => resolve(true), DEMO_TIMEOUT_MS).unref()),
  ]);

  if (timedOut) {
    console.log(`No response after ${DEMO_TIMEOUT_MS / 60_000} minutes, exiting.`);
  } else {
    await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
  }

  process.exit(0);
}
