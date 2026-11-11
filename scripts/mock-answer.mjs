#!/usr/bin/env node
/**
 * Simulated handset for the MOCK telephony provider (no real phone calls).
 * Waits for the next ringing simulated call, "answers" it, prints what the
 * voice said, and presses a key -- exactly what the dashboard's mock phone
 * panel does, but scriptable.
 *
 *   node scripts/mock-answer.mjs --press 1          # approve
 *   node scripts/mock-answer.mjs --press 0          # reject
 *   node scripts/mock-answer.mjs --press 9 --press 1  # invalid key, then approve
 *
 * Env: AGENTBRIDGE_URL (default http://127.0.0.1:4317), and the dashboard
 * password from AGENTBRIDGE_DASHBOARD_PASSWORD or <data dir>/dashboard-password.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

if (existsSync('.env')) process.loadEnvFile('.env');

const { values } = parseArgs({
  options: {
    press: { type: 'string', multiple: true, default: [] },
    timeout: { type: 'string', default: '120' },
  },
});

const base = (process.env.AGENTBRIDGE_URL ?? `http://127.0.0.1:${process.env.AGENTBRIDGE_PORT ?? 4317}`).replace(/\/+$/, '');
const dataDir = process.env.AGENTBRIDGE_DATA_DIR ?? join(homedir(), '.agentbridge');
const password =
  process.env.AGENTBRIDGE_DASHBOARD_PASSWORD ?? readFileSync(join(dataDir, 'dashboard-password'), 'utf8').trim();

const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password }),
});
if (!login.ok) {
  console.error(`Login failed: HTTP ${login.status}`);
  process.exit(1);
}
const cookie = login.headers.get('set-cookie').split(';')[0];
const headers = { cookie, 'x-agentbridge-csrf': '1', 'content-type': 'application/json' };

const deadline = Date.now() + Number(values.timeout) * 1000;
let call = null;
console.log('Waiting for a simulated call (mock provider - no real phone call is placed)...');
while (!call && Date.now() < deadline) {
  const res = await fetch(`${base}/api/mock-phone`, { headers });
  if (res.status === 404) {
    console.error('The server is not using the mock telephony provider.');
    process.exit(1);
  }
  const { calls } = await res.json();
  call = calls.find((c) => c.state === 'ringing') ?? null;
  if (!call) await new Promise((r) => setTimeout(r, 500));
}
if (!call) {
  console.error('No simulated call arrived in time.');
  process.exit(1);
}

const act = async (action, body = {}) => {
  const res = await fetch(`${base}/api/mock-phone/${call.callId}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return (await res.json()).mock;
};

let shown = 0;
const show = (view) => {
  for (const line of view.transcript.slice(shown)) console.log(`  ${line.startsWith('[') ? line : `VOICE: ${line}`}`);
  shown = view.transcript.length;
};

console.log(`Simulated call ${call.callId} for decision ${call.decisionId} is ringing. Answering.`);
show(await act('answer'));
for (const digit of values.press) {
  show(await act('press', { digit }));
}
