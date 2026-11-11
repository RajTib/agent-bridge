# Security model

## Invariant

> Claude Code receives `allow` **only** when a human explicitly approved **that exact
> pending action**, by pressing 1 on the call bound to it or by clicking Approve on the
> authenticated dashboard, before it expired.

Everything else fails closed:

| Situation | Result |
| --- | --- |
| Timeout | Decision → `expired`; hook prints nothing (normal prompt) or denies (`APPROVAL_TIMEOUT_BEHAVIOR=deny`) |
| Call failed / busy / no answer | Retried up to `CALL_MAX_ATTEMPTS`; the decision stays pending, then expires |
| Invalid key / silence | Re-prompt up to `DTMF_MAX_PROMPTS`, then hang up; not approved |
| Server unreachable / crashes | Hook prints nothing → Claude Code's own prompt |
| Malformed or mismatched server response | Treated as not approved |
| Hook killed (you answered in the terminal) | Heartbeat lapses → decision `cancelled`, call hung up |
| Session ended | Its pending decisions are cancelled |

The approval state machine (`packages/core/src/decisions.ts`) moves `pending` to a terminal
state exactly once, via a SQLite compare-and-set (`UPDATE ... WHERE status='pending' AND
expires_at > now`). Racing phone, dashboard and expiry decisions cannot both win.

## Phone webhooks

A webhook changes state only if **all** of these hold:

1. **Signature**: `X-Twilio-Signature` (HMAC-SHA1 over the exact public URL and sorted POST
   params), compared in constant time. The implementation is cross-checked in tests against
   Twilio's official SDK.
2. **Call binding**: the `callId` in the URL (128-bit random) exists, belongs to this
   provider, and the `CallSid` matches the call we placed.
3. **Trusted number**: `To` is in `TRUSTED_PHONE_NUMBERS`. Calls are also never placed to
   any other number.
4. **Single-use prompt**: every keypad prompt carries a sequence number. A key press is
   accepted only for the currently outstanding prompt, and only once (recorded in
   `processed_webhooks`).

So a captured webhook can't be replayed (stale or used sequence), re-pointed at another
call (the signature covers the URL), or altered (the signature covers the digits). Each call
is bound to exactly one decision id, so one call can never authorize a different action.

## Authentication

- **Hook API**: 256-bit bearer token (`<data dir>/hook-token`, mode 0600, or
  `AGENTBRIDGE_HOOK_TOKEN`), compared in constant time.
- **Dashboard**: password (≥ 12 chars) → random session token. Only its SHA-256 is stored
  server-side; it lives in an `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS) with
  a 12 h lifetime. Mutations also require the `x-agentbridge-csrf` header and a same-origin
  `Origin`. Login is rate limited (10 per 15 min per IP); the API is limited globally.
- **Network**: binds `127.0.0.1` by default. For real calls, expose it only through an
  HTTPS tunnel. Everything except `/telephony/*` and `/api/health` still requires
  authentication through the tunnel.

## Data handling

- Secrets come only from environment variables or 0600 files in the data dir. They are
  never logged: authorization, cookie and signature headers are redacted from request logs.
- Phone numbers are masked everywhere they are displayed or logged (`+91******3210`).
- Tool inputs are passed through secret redaction (bearer tokens, API keys, GitHub/AWS/
  Anthropic/OpenAI-style keys, `password=`/`token=` assignments, private keys) before they
  are stored, shown, spoken or sent to Discord.
- The voice never reads raw commands. It speaks a short summary; the full (redacted) input
  is on the dashboard.
- Discord is notification-only, with mentions disabled.
- The dashboard uses a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`) and
  renders agent-supplied text as text, never HTML.

## Known limitations

- The risk classifier is a heuristic for prioritization. It is not a security boundary.
- Anyone who can read your data directory (same OS user) can use the hook token. That is
  the same trust level as Claude Code itself.
- On a Twilio trial account, Twilio prepends its own announcement to each call.
