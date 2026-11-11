#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigError, loadConfig } from '@agentbridge/core';
import { buildApp, startServices } from './app.js';

async function main(): Promise<void> {
  const envFile = resolve(process.env.AGENTBRIDGE_ENV_FILE ?? '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const { app, services } = await buildApp({ config });
  startServices(services);

  await app.listen({ host: config.host, port: config.port });

  const status = services.calls.status();
  const line = (k: string, v: string) => console.log(`  ${k.padEnd(18)} ${v}`);
  console.log('\nAgentBridge is running');
  line('Dashboard', `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`);
  line(
    'Dashboard password',
    services.secrets.passwordSource === 'env'
      ? 'from AGENTBRIDGE_DASHBOARD_PASSWORD'
      : `stored in ${services.secrets.passwordPath}`,
  );
  line(
    'Hook token',
    services.secrets.hookTokenSource === 'env' ? 'from AGENTBRIDGE_HOOK_TOKEN' : `stored in ${services.secrets.hookTokenPath}`,
  );
  line(
    'Telephony',
    `${status.name}${status.isRealCall ? ' (REAL phone calls)' : status.name === 'mock' ? ' (SIMULATED - no real calls)' : ''} - ${
      status.enabled ? `enabled, calling ${status.toMasked}` : 'NOT enabled'
    }`,
  );
  for (const p of status.problems) line('', `! ${p}`);
  line('Webhook base URL', services.webhookBaseUrl ?? '(none)');
  line('Discord', services.discord ? 'enabled' : 'disabled');
  line('Database', config.dbPath);
  console.log('');

  const shutdown = async (signal: string) => {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
