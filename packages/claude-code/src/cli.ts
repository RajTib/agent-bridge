#!/usr/bin/env node
/**
 * agentbridge-hooks: install/uninstall the Claude Code hooks and check that
 * the hook can reach the AgentBridge server.
 *
 *   node packages/claude-code/dist/cli.js install [--project <dir>] [--timeout <s>] [--dry-run]
 *   node packages/claude-code/dist/cli.js uninstall [--project <dir>] [--dry-run]
 *   node packages/claude-code/dist/cli.js status
 */
import { parseArgs } from 'node:util';
import { defaultHookScriptPath, installHooks, settingsPathFor, uninstallHooks } from './install.js';
import { hookRequest, resolveHookEnv } from './hook.js';

async function status(): Promise<number> {
  const env = resolveHookEnv();
  console.log(`Server URL : ${env.baseUrl}`);
  console.log(`Hook token : ${env.token ? 'found' : 'MISSING (start the server once, or set AGENTBRIDGE_HOOK_TOKEN)'}`);
  if (!env.token) return 1;
  try {
    const res = await hookRequest(env, 'GET', '/api/hooks/ping', undefined, 3000);
    if (res.status === 200) {
      console.log('Connection : OK (mutually authenticated with the hook token)');
      return 0;
    }
    console.log(`Connection : server answered HTTP ${res.status}`);
  } catch (err) {
    console.log(`Connection : FAILED (${(err as Error).message}) -- is the server running?`);
  }
  return 1;
}

async function main(): Promise<number> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string' },
      timeout: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const command = positionals[0];
  const settingsPath = settingsPathFor({ project: values.project });
  const dryRun = values['dry-run'] ?? false;

  switch (command) {
    case 'install': {
      const approval = Number(process.env.APPROVAL_TIMEOUT_SECONDS ?? 300);
      const timeout = Number(values.timeout ?? approval + 30);
      if (!Number.isInteger(timeout) || timeout < 30 || timeout > 3700) {
        console.error('--timeout must be an integer number of seconds between 30 and 3700');
        return 1;
      }
      if (timeout <= approval) {
        console.warn(
          `Warning: hook timeout (${timeout}s) <= approval timeout (${approval}s). Claude Code may stop waiting first; that is safe (nothing is approved) but wastes the call.`,
        );
      }
      const { settings, backup } = installHooks({ settingsPath, permissionTimeoutSeconds: timeout, dryRun });
      if (dryRun) {
        console.log(JSON.stringify(settings.hooks, null, 2));
        return 0;
      }
      console.log(`Installed AgentBridge hooks into ${settingsPath}`);
      console.log(`  hook script : ${defaultHookScriptPath()}`);
      console.log(`  events      : PermissionRequest (gate, ${timeout}s), SessionStart, SessionEnd, Notification, Stop, StopFailure`);
      if (backup) console.log(`  backup      : ${backup}`);
      console.log('Restart Claude Code (or run /hooks) so it picks up the new hooks.');
      return 0;
    }
    case 'uninstall': {
      const { settings, backup } = uninstallHooks({ settingsPath, dryRun });
      if (dryRun) {
        console.log(JSON.stringify(settings.hooks ?? {}, null, 2));
        return 0;
      }
      console.log(`Removed AgentBridge hooks from ${settingsPath}${backup ? ` (backup: ${backup})` : ''}`);
      return 0;
    }
    case 'status':
      return status();
    default:
      console.log(
        [
          'Usage:',
          '  install   [--project <dir>] [--timeout <seconds>] [--dry-run]',
          '  uninstall [--project <dir>] [--dry-run]',
          '  status',
          '',
          'Without --project, hooks go into ~/.claude/settings.json (all projects).',
          'With --project, hooks go into <dir>/.claude/settings.local.json (that project only, git-ignored).',
        ].join('\n'),
      );
      return command ? 1 : 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  },
);
