# Architecture

```
            ┌──────────────── host machine ────────────────┐
 Claude Code│  hook.js (short-lived, per event)             │
  ──stdin──▶│   POST /api/hooks/permission-request          │
  ◀─stdout──│   GET  /api/hooks/decisions/:id/wait (poll)   │
            │                    │ bearer token             │
            │        ┌───────────▼────────────────────────┐ │        ┌──────────┐
            │        │ apps/server (Fastify, 127.0.0.1)   │◀┼─tunnel─│  Twilio  │──▶ phone
            │        │  routes ─ auth ─ SSE ─ webhooks    │ │ HTTPS  └──────────┘
            │        │   │                                │ │
            │        │   ├─ DecisionService (state machine)│ │
            │        │   ├─ SessionService / Audit        │ │
            │        │   ├─ CallManager ─ TelephonyProvider│ │
            │        │   ├─ DiscordNotifier ──────────────┼─┼──▶ Discord webhook
            │        │   └─ Store (node:sqlite, WAL)      │ │
            │        └───────────▲────────────────────────┘ │
            │   browser dashboard │ cookie + CSRF, SSE        │
            └───────────────────────────────────────────────┘
```

## Components

- **packages/core**: `loadConfig` (env only, validated, lists every problem at once);
  `openDatabase` with ordered migrations; `Store` (typed SQL); `DecisionService`
  (create/dedupe, resolve with compare-and-set, expire, cancel, long-poll `wait`, a sweeper
  for expiry and heartbeats); `SessionService`; `Audit` (append-only `events` table, also
  broadcast on the bus); `EventBus`; `assessRisk`; `describeAction` (summary, spoken
  phrase, redacted detail).
- **packages/telephony**: the `TelephonyProvider` interface, `TwilioProvider` (REST + TwiML,
  no SDK), `MockTelephonyProvider` (simulated handset), and `CallManager` (queue, retries,
  DTMF dialogue, webhook trust checks, watchdogs), plus the `voice-script` texts.
- **packages/claude-code**: the hook client (`hook.js`), fail-closed output rendering, and
  the settings installer and CLI.
- **packages/discord**: event → embed mapping and a rate-limit-aware sender.
- **apps/server**: wires the services into Fastify. It handles auth, rate limiting,
  security headers, the SSE stream, the telephony webhook route, and the mock-phone routes
  (they deliver signed webhooks through `app.inject`, the same path a carrier uses). It also
  serves the built dashboard.
- **apps/dashboard**: React SPA. It holds its state from REST plus SSE upserts.

## Data model (SQLite)

`sessions`, `decisions` (with a partial unique index that allows at most one *pending*
decision per dedupe key), `calls`, `events` (audit), `processed_webhooks` (replay ledger),
`dashboard_sessions` (hashed tokens), and `schema_migrations`. All timestamps are ISO-8601
UTC strings.

## Why a long-lived server plus a short-lived hook

Claude Code spawns a fresh process for each hook, so the state (pending decisions, calls,
webhooks) has to live in a process that outlives any single hook. The hook is a thin,
dependency-free client that waits by long-polling, so a server restart mid-wait is
tolerated: the decision is in SQLite and the hook keeps polling.

## History

v0 of this repository was a channel-agnostic relay (Discord bot buttons plus an
unfinished web adapter). v2 rebuilt it around phone-call approval. The v0 code remains in
git history (`main` before the v2 merge) and on the `archive/v0-web-adapter-wip` branch.
