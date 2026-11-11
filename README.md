# AgentBridge

**Approve Claude Code's actions from your phone, by actually picking up the phone.**

When Claude Code hits an action that needs your permission, AgentBridge calls you. A voice
explains what Claude wants to do, and you answer on the keypad:

> "Hello. This is AgentBridge calling on behalf of Claude Code. In the project
> payments-service, Claude wants to install a new dependency called jsonwebtoken.
> It needs your approval because your Claude Code permission settings require
> confirmation for this action. To approve this action, press 1. To reject this
> action, press 0. To repeat this message, press 2."

Your key press goes straight back to the waiting Claude Code permission prompt. A live
dashboard shows the full details, call history and audit trail, and gives you manual
approve/reject buttons as a fallback. Discord notifications are optional.

```
Claude Code ──PermissionRequest hook──▶ AgentBridge server ──REST──▶ Twilio ──▶ your phone
     ▲                                     │   ▲                                 │ keypad 1 / 0
     └──── allow / deny (hook stdout) ─────┘   └──── signed DTMF webhook ◀───────┘
                                           │
                                           ├──▶ dashboard (SSE live updates, manual fallback)
                                           └──▶ Discord webhook (optional notifications)
```

## Safety first

- **Fail closed.** Only an explicit approval of *that exact* pending action produces an
  `allow`. Timeouts, failed or unanswered calls, invalid keys, an unreachable server, or a
  malformed response never approve anything. Claude Code falls back to its normal prompt
  (or, with `APPROVAL_TIMEOUT_BEHAVIOR=deny`, is told the action was denied).
- **Respects your permission rules.** AgentBridge hooks Claude Code's `PermissionRequest`
  event, which only fires when Claude Code would have asked you anyway. Your
  allow/deny/ask rules are untouched, and AgentBridge never adds permanent allow rules.
- **One call, one action.** Every call is bound to one unguessable decision id. Webhooks
  are signature-verified, bound to the provider call id and a trusted number, and each
  keypad prompt can be answered exactly once, so a replayed webhook can't approve
  anything.
- No blanket "approve everything" option exists.

See [docs/security.md](docs/security.md).

## Quick start (simulated calls, about 2 minutes)

Requirements: Node.js 22.13+ (24 recommended), Git, Claude Code.

```bash
npm install
npm run setup          # creates .env with a generated dashboard password
npm run build
npm start              # http://127.0.0.1:4317 (password is in .env)
npm run hooks:install  # adds the hooks to ~/.claude/settings.json (backup made)
node packages/claude-code/dist/cli.js status   # checks hook -> server connectivity
```

`TELEPHONY_PROVIDER=mock` is the default. **The mock provider places no real phone calls.**
It runs the whole flow through the same signed-webhook code path, and you play the phone in
the dashboard's **Mock phone** panel or from the terminal:

```bash
node scripts/mock-answer.mjs --press 1    # answer the next simulated call and approve
```

Now ask Claude Code to do something that needs permission, such as running a shell
command. The decision appears on the dashboard, a simulated call rings, and pressing 1 lets
Claude continue.

To install the hooks for a single project instead of globally:
`node packages/claude-code/dist/cli.js install --project /path/to/project` (writes the
git-ignored `.claude/settings.local.json`). Remove them with `npm run hooks:uninstall`.

## Real phone calls (Twilio)

1. Create a Twilio account and get a voice number. On a trial account, **verify your own
   mobile number** under *Verified Caller IDs*.
2. Expose the server over HTTPS so Twilio can deliver key presses, for example:
   `cloudflared tunnel --url http://127.0.0.1:4317` (or `ngrok http 4317`).
3. Set the following in `.env`, then restart:
   ```ini
   TELEPHONY_PROVIDER=twilio
   PHONE_TO_NUMBER=+91XXXXXXXXXX
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+1XXXXXXXXXX
   AGENTBRIDGE_PUBLIC_URL=https://<your-tunnel-host>
   ```
4. The dashboard header should read **"Twilio · real calls"**. Use **Call me** on a pending
   decision to test.

Provider evaluation, India-specific notes (caller ID, TRAI/DLT, trial limits) and how to add
providers: [docs/telephony.md](docs/telephony.md).

## Configuration

All configuration is through environment variables. See [.env.example](.env.example) for
the full, commented list. Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `APPROVAL_TIMEOUT_SECONDS` | 300 | How long a request waits for a decision |
| `APPROVAL_TIMEOUT_BEHAVIOR` | `ask` | `ask` returns to Claude Code's prompt; `deny` denies. Neither approves |
| `CALL_MIN_RISK` | `low` | Only call for requests at or above this risk |
| `CALL_MAX_ATTEMPTS` | 2 | Calls per decision (unanswered or failed calls are retried) |
| `DTMF_MAX_PROMPTS` | 3 | Invalid inputs or silences before hanging up (not approved) |
| `TRUSTED_PHONE_NUMBERS` | `PHONE_TO_NUMBER` | Calls are only placed to, and accepted from, these numbers |

## Docker

```bash
docker compose up -d --build     # dashboard on 127.0.0.1:4317, data in ./data
```

The hook runs on the host. Point it at the container's token with
`AGENTBRIDGE_DATA_DIR=<repo>/data` (or set the same `AGENTBRIDGE_HOOK_TOKEN` in both
places).

## Development

```bash
npm run build      # tsc project references + Vite dashboard build
npm run lint
npm test           # unit, HTTP integration and end-to-end tests (run after build)
npm run dev:dashboard   # Vite dev server on :5173, proxied to the API on :4317
```

Layout:

```
apps/server          Fastify server: hook API, telephony webhooks, dashboard API + SSE
apps/dashboard       React + Vite dashboard
packages/shared      domain types shared by everything
packages/core        config, SQLite store + migrations, decision state machine, risk, redaction
packages/telephony   provider interface, Twilio, mock, call manager, voice script
packages/claude-code hook client, settings installer, output rendering
packages/discord     Discord webhook notifier
tests/               end-to-end tests (the real hook script as a child process)
scripts/             setup and simulated handset helpers
```

More: [architecture](docs/architecture.md) · [Claude Code integration](docs/claude-code.md) ·
[telephony](docs/telephony.md) · [security](docs/security.md)

## License

MIT. See [LICENSE](LICENSE).
