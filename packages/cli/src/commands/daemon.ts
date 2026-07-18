import { join } from 'node:path';
import { startDaemon } from '@agentbridge/core';

const DEFAULT_CONFIG_RELATIVE = 'config/agentbridge.yml';

/**
 * `agentbridge daemon start` -- runs in the foreground. No background
 * service/systemd integration in the MVP; if you want it running
 * persistently, start it in its own terminal (or wrap it with something
 * like pm2/nssm yourself for now).
 */
export async function runDaemonStart(): Promise<void> {
  const configPath = process.env.AGENTBRIDGE_CONFIG ?? join(process.cwd(), DEFAULT_CONFIG_RELATIVE);
  console.log(`Starting AgentBridge daemon (config: ${configPath})...`);
  await startDaemon({ configPath });
  console.log('Daemon running. Press Ctrl+C to stop.');
}
