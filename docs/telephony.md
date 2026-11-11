# Telephony

## Provider choice for a developer in India

| Provider | Outbound to Indian mobiles | TTS + DTMF | Webhooks + signatures | Onboarding | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Twilio** | Yes, from an international (non-Indian) caller ID | `<Say>` (Amazon Polly / Google voices, `en-IN`), `<Gather input="dtmf">` | Yes, `X-Twilio-Signature` (HMAC-SHA1) | Self-serve signup; trial works with your *verified* number | **Chosen (implemented)** |
| Exotel | Yes, Indian ExoPhone caller ID | Via Flows/Gather applets built in their dashboard | Passthru applets; limited signing | **KYC with Indian business documents is mandatory** before outbound calls | Good later for an Indian caller ID; heavier setup |
| Plivo | Yes | `<Speak>`, `<GetDigits>` | Yes (V3 signatures) | Self-serve; India has its own compliance flow | Viable second provider |
| Vonage | Yes | NCCO talk + input | Signed JWT webhooks | Self-serve | Viable |

Why Twilio first: a fully programmable call (dynamic text per decision, keypad capture,
status callbacks) with no dashboard-built flows. It has documented webhook signatures, and
a solo developer can start the same day on a trial account calling their own verified
number. Exotel is the strongest local option, but its mandatory KYC and flow-builder model
make it a poor first integration.

### India notes (verify current rules in your Twilio console)

- Twilio's India voice guidelines say calls *to* India must use a **non-Indian caller ID**,
  so your phone will show an international number. Save it as a contact ("AgentBridge").
- **Trial accounts** can only call verified numbers and prefix calls with a trial
  announcement ("press any key to execute your code"). Press a key, then AgentBridge
  speaks. Upgrade the account to remove this.
- TRAI/DLT rules target commercial/promotional calling. A call to your own number about
  your own agent is transactional and personal, but carriers may still filter
  international caller IDs. If calls don't arrive, check the Twilio call log
  (`failed`/`no-answer`) and your phone's spam/DND settings.
- Billing: outbound calls are charged per minute at Twilio's India rate. A typical approval
  call takes 20–40 seconds.

## Twilio setup

1. Sign up at twilio.com and note the **Account SID** and **Auth Token**.
2. Get a voice-capable number (trial gives you one). This is `TWILIO_FROM_NUMBER`.
3. On a trial account: Console → Phone Numbers → **Verified Caller IDs** → add your mobile.
4. Run a public HTTPS tunnel to the server:
   - `cloudflared tunnel --url http://127.0.0.1:4317` (prints `https://<random>.trycloudflare.com`), or
   - `ngrok http 4317`.
5. Put the values into `.env` (see README), restart, and check the dashboard's provider pill.

You don't need to configure anything on the Twilio number itself. AgentBridge passes the
webhook URLs with each outbound call.

> **Signature URLs must match.** Twilio signs the exact public URL. `AGENTBRIDGE_PUBLIC_URL`
> must be the tunnel URL with no trailing path. If you change tunnels, update it and
> restart.

## Call flow

```
decision created ─▶ risk ≥ CALL_MIN_RISK? ─▶ queue (one active call at a time)
  └─▶ POST /Calls.json (To, From, Url=/telephony/twilio/<callId>/voice?seq=0, StatusCallback)
       ├─ answered ─▶ voice webhook ─▶ <Gather numDigits=1 action=/gather?seq=N> intro + menu
       │     ├─ 1 ─▶ approve (if still pending & unexpired) ─▶ "Approved. Goodbye." hang up
       │     ├─ 0 ─▶ reject ─▶ "Rejected. Goodbye."
       │     ├─ 2 ─▶ repeat summary + menu (new seq)
       │     ├─ other key / silence ─▶ re-prompt, up to DTMF_MAX_PROMPTS, then hang up (NOT approved)
       │     └─ decided elsewhere meanwhile ─▶ "already approved/rejected/expired", hang up
       └─ busy / no-answer / failed ─▶ retry after CALL_RETRY_DELAY_SECONDS, up to CALL_MAX_ATTEMPTS
```

If you decide on the dashboard while the phone is ringing, the call is cancelled via the
API. A watchdog closes calls whose final status callback never arrives, so the queue never
stalls.

## Provider interface

`packages/telephony/src/types.ts`:

```ts
interface TelephonyProvider {
  name; isRealCall; requiresPublicUrl;
  health(): { configured, problems[] };
  makeCall(req): Promise<{ providerCallId }>;          // makeCall()
  verifyWebhook(req): boolean;                          // handleIncomingWebhook(): trust
  parseWebhook(req): { providerCallId, to, digits, callStatus };  //  ... and parse
  renderResponse(actions, voice): { contentType, body };// collectDigits() = a 'gather' action
  getCallStatus(providerCallId); terminateCall(providerCallId);
}
```

The call manager speaks provider-neutral `VoiceAction`s (`say`, `gather`, `redirect`,
`pause`, `hangup`). A new provider (Plivo, Exotel, Vonage) only renders those and parses
its webhooks. Register it in `createProvider()`.

## Mock provider

`TELEPHONY_PROVIDER=mock` places **no real calls** (`isRealCall: false`; the dashboard,
logs and audit trail all say "SIMULATED"). It still sends every answer or key press as a
signed webhook through the real HTTP route, so the verification, replay protection and
DTMF logic you test are the production code paths.
