#!/usr/bin/env node

import { runInstall } from './commands/install';
import { runHook } from './commands/hook';
import { runDemoDiscord } from './commands/demo-discord';
import { runDaemonStart } from './commands/daemon';

const [, , command, subcommand] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'install':
      runInstall(subcommand);
      return;
    case 'hook':
      await runHook();
      return;
    case 'daemon':
      if (subcommand === 'start') {
        await runDaemonStart();
        return;
      }
      console.error(`Unknown daemon command "${subcommand ?? ''}". Supported: start`);
      process.exitCode = 1;
      return;
    case 'demo':
      if (subcommand === 'discord') {
        await runDemoDiscord();
        return;
      }
      console.error(`Unknown demo target "${subcommand ?? ''}". Supported: discord`);
      process.exitCode = 1;
      return;
    default:
      console.log(
        [
          'AgentBridge CLI',
          '',
          'Usage:',
          '  agentbridge install claude-code   Install Claude Code hooks into ~/.claude/settings.json',
          '  agentbridge daemon start          Start the relay daemon (run this first, keep it running)',
          '  agentbridge demo discord          Send a live test approval request to Discord directly',
          '  agentbridge hook <event>          (internal — invoked by the installed hooks)',
        ].join('\n'),
      );
  }
}

main();
