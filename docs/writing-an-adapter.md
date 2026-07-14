# Writing an adapter

> Draft — expanded into full `CONTRIBUTING.md` guidance once the Claude Code and Discord
> adapters exist as reference implementations.

Every adapter implements one interface from `packages/contracts/src/adapters.ts` and
nothing else — adapters never import each other, and never import `packages/core`'s
internals.

- **New agent** → implement `AgentAdapter`: `normalize()` turns the tool's native
  hook/event payload into a `NormalizedEvent`; `deliverOutcome()` turns a decided
  `ApprovalOutcome` back into whatever that tool expects (exit code, stdout JSON, file).
- **New channel** → implement `ChannelAdapter`: `send()` renders and delivers a
  `PendingApproval` with full, untruncated context; register a decision handler via
  `onDecision()` and report human actions back through it. Channel adapters must not touch
  the filesystem directly.
