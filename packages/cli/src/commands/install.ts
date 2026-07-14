import { installHooks } from '@agentbridge/adapter-claude-code';

const SUPPORTED_AGENTS = ['claude-code'] as const;

export function runInstall(agent: string | undefined): void {
  if (!agent || !(SUPPORTED_AGENTS as readonly string[]).includes(agent)) {
    console.error(
      `Unknown or missing agent "${agent ?? ''}". Supported: ${SUPPORTED_AGENTS.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  // Only one supported agent for now; a future agent would get its own
  // installHooks() from its own adapter package, dispatched here by name.
  installHooks();
  console.log('Installed AgentBridge hooks into ~/.claude/settings.json (PreToolUse, Notification, Stop).');
}
