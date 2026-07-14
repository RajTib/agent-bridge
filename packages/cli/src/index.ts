#!/usr/bin/env node

import { runInstall } from './commands/install';
import { runDebugHook } from './commands/debug-hook';
import { runDemoDiscord } from './commands/demo-discord';

const [, , command, subcommand] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'install':
      runInstall(subcommand);
      return;
    case 'hook':
      // All hook events route here for now (see debug-hook.ts). Step 5 will
      // teach this to talk to the core relay instead of just logging.
      await runDebugHook();
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
          '  agentbridge demo discord          Send a live test approval request to Discord',
          '  agentbridge hook <event>          (internal — invoked by the installed hooks)',
        ].join('\n'),
      );
  }
}

main();
