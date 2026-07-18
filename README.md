# AgentBridge

A provider-agnostic, agent-agnostic approval/notification router for AI coding agents.

When an AI coding agent (Claude Code first, others later) needs human input or permission
to run something, AgentBridge relays the request — with full, untruncated context — to a
human-facing channel (Discord first, others later), and relays the human's Approve/Deny
decision back to the agent.

> **Status:** MVP in progress. The full pipeline (hook → daemon → relay → Discord → decision
> round-trip) works and is verified with a simulated Claude Code hook payload. Not yet
> validated against a real, live Claude Code session -- that's the next milestone.

## What this is not

AgentBridge is **not** about making multiple AI agents collaborate with each other. It is
a router between one AI agent that needs a human decision and one human-facing channel
that decision can be made from.

## Prior art, and why this project exists anyway

Claude Code ships native mobile push+approve (Remote Control), and OpenAI's Codex has its
own mobile app with the same capability. Several single-purpose open-source scripts already
bridge Claude Code to Discord, ntfy, or Telegram individually.

None of that is what AgentBridge is for. Each of those solves "notify me on my phone" for
exactly one agent and, often, exactly one channel. AgentBridge is for the case where you
use more than one coding agent, or want to route approvals to more than one channel,
without maintaining a separate hardcoded script per (agent, channel) pair. It does this with:

- A real adapter interface (`AgentAdapter`, `ChannelAdapter`) — adding a new agent or
  channel means implementing an interface, not forking a script.
- A security model that doesn't rely on a shared-secret topic name. Each pending approval
  gets a signed, single-use, expiring token.
- Full, unabridged context delivered to the human. Approval UIs that truncate or summarize
  the dangerous part of a command are a known vulnerability class (dubbed *GhostApproval*
  after several agent approval UIs were found hiding risky details from reviewers in 2026).
- A structured, append-only audit log of every decision: who approved what, when, and from
  where.
- A safe timeout: if nobody responds in time, control falls back to the agent's normal
  terminal prompt rather than silently blocking or auto-approving.

## Architecture

```
 AI agent (Claude Code, ...)
        │  native hook/event format
        ▼
 ┌───────────────┐        normalized event         ┌──────────────┐
 │ Agent adapter │ ───────────────────────────────▶ │  Core relay  │
 │ (per-agent)   │ ◀─────────────────────────────── │  (daemon)    │
 └───────────────┘        approval outcome          └──────┬───────┘
                                                             │ pending approval
                                                             ▼
                                                     ┌────────────────┐
                                                     │ Channel adapter │
                                                     │ (per-channel)   │
                                                     └────────┬────────┘
                                                              │ render + deliver
                                                              ▼
                                                          human (Discord, ...)
```

- **Agent adapters** translate a tool's native hook/event format into one normalized shape
  (`{ agent, sessionId, eventType, summary, fullContext, riskHint }`) and translate a
  decided outcome back into whatever that tool expects (exit code, stdout JSON, decision
  file).
- **Core relay** owns the approval lifecycle end to end: pending → approved / denied /
  timed out. Issues signed, single-use, expiring tokens per pending approval. Routes events
  to channels per `config/agentbridge.yml`. Writes a structured audit log.
- **Channel adapters** are pure send/receive: render a pending approval with full context,
  deliver it, and report the human's decision back to the core relay. They never touch the
  filesystem directly.

Full interface definitions live in `packages/contracts`.

## Repo layout

```
packages/
  contracts/              shared types + AgentAdapter / ChannelAdapter interfaces
  core/                    the relay daemon: state machine, tokens, audit log, routing
  adapters-agent/
    claude-code/           Claude Code hook installer + event normalizer
  adapters-channel/
    discord/               Discord bot: message renderer + Approve/Deny handler
  cli/                     the `agentbridge` command users actually run
config/
  agentbridge.example.yml  routing config template
docs/
  architecture.md
  security.md
  writing-an-adapter.md
```

## Development

```bash
npm install
npm run build
npm run lint
npm run typecheck
npm test
```

## Roadmap (MVP)

- [x] Repo scaffold, tooling, CI
- [x] Claude Code agent adapter (hook installer + normalizer)
- [x] Discord channel adapter (bot + renderer + button handler)
- [x] Core relay (state machine, signed tokens, timeout, audit log)
- [ ] End-to-end demo (fake PermissionRequest → Discord → Approve → decision round-trip)
- [ ] `CONTRIBUTING.md` — how to add a new agent or channel adapter

## License

MIT — see [LICENSE](./LICENSE).
