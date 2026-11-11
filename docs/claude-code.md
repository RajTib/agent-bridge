# Claude Code integration

Verified against the official hooks reference (code.claude.com/docs/en/hooks) and against
a live Claude Code session (v2.1.319, headless `claude -p`): the hook fired, a simulated
call pressing **1** let the Bash command run, and pressing **0** produced a permission
denial that Claude respected without retrying.

## Which hook, and why

| Hook | Used for | Can it gate? |
| --- | --- | --- |
| **PermissionRequest** | The approval gate | Yes. `decision.behavior` is `allow` or `deny` |
| SessionStart / SessionEnd | Session tracking; ending a session cancels its pending decisions | No |
| Notification | Timeline / Discord | No |
| Stop | "Task completed" | No |
| StopFailure | "Task failed" (rate limit, auth, ...) | No |

We deliberately **do not** gate on `PreToolUse`. It fires for every tool call, including
ones your rules already allow, and returning `allow` there skips the permission prompt.
That would let AgentBridge approve things Claude Code would never have asked about.
`PermissionRequest` runs only when Claude Code is about to ask you, so your existing
`permissions.allow/deny/ask` rules stay authoritative. The docs also note that deny and ask
rules are still evaluated after a hook `allow`.

## Contract

Input (stdin): `session_id`, `cwd`, `tool_name`, `tool_input`, `permission_mode`,
`permission_suggestions`, plus the common fields. There is no `tool_use_id` for this event.

Output (stdout), only for a human decision:

```json
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }
{ "hookSpecificOutput": { "hookEventName": "PermissionRequest",
    "decision": { "behavior": "deny", "message": "The developer rejected this action via AgentBridge (phone)..." } } }
```

AgentBridge never returns `updatedInput`, so the reviewed action is exactly the action that
runs. It never returns `updatedPermissions`, so approving once never creates a standing rule.

No output (exit 0) means "no decision". Claude Code then shows its normal prompt, and in
non-interactive mode it denies. That is what happens on timeout, cancellation, an
unreachable server, or any unexpected response (fail closed). With
`APPROVAL_TIMEOUT_BEHAVIOR=deny`, the hook sends an explicit deny instead.

Exit code 2 is not honored for `PermissionRequest`, so the hook always exits 0 and conveys
decisions via JSON only.

`AskUserQuestion` and `ExitPlanMode` are passed through untouched. Allowing them needs
`updatedInput` (answers or plan edits), which a keypad cannot provide.

## Flow

1. Claude Code runs `node .../hook.js PermissionRequest --agentbridge` with the payload on stdin.
2. The hook `POST`s `/api/hooks/permission-request` (HMAC-signed; the token is never sent). The server creates a
   decision `dec_<128-bit random>`, or reuses an identical pending one (duplicate
   protection: same agent + session + tool + input).
3. The hook long-polls `/api/hooks/decisions/:id/wait` (20 s slices, each a heartbeat). If
   polling stops for `HOOK_HEARTBEAT_GRACE_SECONDS` (for example because you answered the
   prompt in the terminal and Claude killed the hook), the decision is cancelled and any
   call is hung up.
4. The hook prints `allow` only if the server reports `status: "approved"` for *its own*
   decision id.

## Timeouts

The installer sets the hook `timeout` to `APPROVAL_TIMEOUT_SECONDS + 30`, so the server
decides first. If Claude Code's timeout fires first anyway, the hook is cancelled. That is
safe: nothing is approved.

## Install / uninstall

```bash
node packages/claude-code/dist/cli.js install                      # ~/.claude/settings.json
node packages/claude-code/dist/cli.js install --project ./my-app   # my-app/.claude/settings.local.json
node packages/claude-code/dist/cli.js install --dry-run            # print, change nothing
node packages/claude-code/dist/cli.js uninstall [--project ...]
node packages/claude-code/dist/cli.js status                       # hook ↔ server check
```

The installer is idempotent. It keeps every other setting and third-party hook, writes a
timestamped backup, and also removes entries left by AgentBridge v0 (`agentbridge hook ...`).
