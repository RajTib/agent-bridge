# Security model

> Draft — finalized alongside `packages/core/src/tokens.ts` and `relay.ts`.

## Why not a shared-secret topic name

Several existing agent-to-channel bridge scripts authenticate a pending approval purely by
a shared-secret channel/topic name (e.g. a private webhook URL). Anyone who learns that
secret can approve or deny arbitrary future requests, and the secret is typically long-lived.

AgentBridge instead issues one signed, single-use, expiring token per pending approval:

- **Signed** — HMAC over `{ approvalId, expiresAt, nonce }`, so a token can't be forged
  without the relay's local signing key.
- **Single-use** — enforced server-side by the approval state machine (a consumed approval
  cannot be decided again), not by the signature alone, since a valid signature can always
  be replayed unless the server tracks consumption.
- **Expiring** — a token past `expiresAt` is rejected outright; the relay's timeout fallback
  takes over independently of whether the token would still verify.

## GhostApproval

In 2026, several agent approval UIs were found truncating or summarizing the dangerous part
of a proposed action (e.g. showing `rm -rf ...` truncated, or collapsing a diff) so the
human approver never saw what they were actually approving. AgentBridge's channel adapters
are required to render `fullContext` in full — truncation for a *preview* (e.g. a
notification summary) is fine; the actual Approve/Deny surface must show the complete
command or diff.

## Threat model (draft — to expand)

- Compromised channel adapter (e.g. a malicious Discord bot token) should not be able to
  approve arbitrary requests it wasn't the target of.
- A leaked audit log should not itself function as a replay vector.
- Timeout fallback must fail closed to the agent's normal terminal prompt, never to
  auto-approve.
