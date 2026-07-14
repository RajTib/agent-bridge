import { randomUUID } from 'node:crypto';
import { createDiscordChannelAdapter } from '@agentbridge/adapter-discord';
import type { PendingApproval } from '@agentbridge/contracts';

const DEMO_TIMEOUT_MS = 5 * 60_000;

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

  adapter.onDecision(async (approvalId, decision, decidedBy) => {
    console.log(`Received decision: ${decision} by ${decidedBy} (approvalId ${approvalId})`);
    process.exit(0);
  });

  console.log('Sending a demo approval request to Discord — go click Approve or Deny there...');
  await adapter.send(approval);

  setTimeout(() => {
    console.log(`No response after ${DEMO_TIMEOUT_MS / 60_000} minutes, exiting.`);
    process.exit(0);
  }, DEMO_TIMEOUT_MS).unref();
}
