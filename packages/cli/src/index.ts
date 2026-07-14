#!/usr/bin/env node

import { runInstall } from './commands/install';
import { runDebugHook } from './commands/debug-hook';

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
    default:
      console.log(
        [
          'AgentBridge CLI',
          '',
          'Usage:',
          '  agentbridge install claude-code   Install Claude Code hooks into ~/.claude/settings.json',
          '  agentbridge hook <event>          (internal — invoked by the installed hooks)',
        ].join('\n'),
      );
  }
}

main();
