# Architecture

See the diagram and component summary in the root [README](../README.md#architecture) for
the high-level picture: agent adapters normalize events, the core relay owns the approval
lifecycle and routing, channel adapters render and deliver to humans.

## The core relay (`packages/core`)

Claude Code hooks are short-lived processes -- each hook invocation spawns a fresh script,
feeds it JSON on stdin, and waits for it to exit. That means the relay can't just be "part
of" the hook script; it has to be a separate, long-running process the short-lived hook
script talks to.

- **`agentbridge daemon start`** runs in the foreground, loads `config/agentbridge.yml`
  (or `config/agentbridge.example.yml`'s defaults if no file exists yet), connects to any
  configured channels (Discord today), and exposes a local-only HTTP API on
  `127.0.0.1:8787` (`AGENTBRIDGE_PORT` to override).
- **`agentbridge hook <event>`** is the short-lived client: normalizes the incoming payload,
  POSTs it to the daemon, and waits for the outcome (up to the configured approval
  timeout). If the daemon isn't reachable at all, it fails safe -- tells Claude Code to fall
  back to its own normal prompt, never silently blocks or auto-approves.
- A shared local secret (`~/.agentbridge/daemon-secret`) is required on every request
  between the CLI and the daemon, so an unrelated local process can't submit fake events or
  read pending state. This is separate from the per-approval signed tokens in
  `packages/core/src/tokens.ts` -- one proves "you're a legitimate AgentBridge process on
  this machine," the other proves "you're allowed to decide this specific approval."

## Resolved decisions

- **CLI ↔ daemon transport: loopback HTTP**, not a Unix domain socket. Chosen for
  portability (this project is developed and tested on Windows) -- a plain HTTP server on
  `127.0.0.1` behaves identically across Windows/macOS/Linux and is trivial to debug with
  `curl`, at the cost of being slightly heavier than a socket for a purely local channel.
- **Audit log scope: summary only, not `fullContext`.** The durable audit log
  (`~/.agentbridge/audit.log.jsonl`) records `summary`, `riskHint`, `decision`, `decidedBy`,
  and `channel` -- not the raw command/diff. A permanent, ever-growing log of every command
  this tool has ever seen would be a bigger standing risk than the audit trail is worth.
  `fullContext` only ever exists in memory (relay) and transiently in the channel message
  (Discord) for the duration of the approval.

## Known MVP simplifications

- Only `permission_required` events go through the full pending-approval → channel → wait
  cycle. `input_required` / `run_completed` / `run_failed` are logged for audit purposes but
  not yet forwarded to a channel -- that needs a plain notify-only method on `ChannelAdapter`
  that doesn't exist yet.
- The daemon runs in the foreground only; there's no background-service/systemd/Windows
  service wrapper in the MVP.
