#!/usr/bin/env node
/**
 * First-run helper: creates .env from .env.example with freshly generated
 * secrets (dashboard password + hook token). Never overwrites an existing .env.
 *
 *   npm run setup
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  const current = readFileSync('.env', 'utf8');
  const missing = ['AGENTBRIDGE_DASHBOARD_PASSWORD', 'TELEPHONY_PROVIDER'].filter(
    (k) => !new RegExp(`^${k}=`, 'm').test(current),
  );
  console.log('.env already exists - leaving it untouched.');
  if (missing.length) {
    console.log(`It does not set: ${missing.join(', ')}. Compare it with .env.example.`);
    console.log('(Unset secrets are generated into ~/.agentbridge on first server start.)');
  }
  process.exit(0);
}

const secret = (n) => randomBytes(n).toString('base64url');
const password = secret(18);
// The hook token is deliberately NOT put in .env: the server generates it into
// ~/.agentbridge/hook-token, which is where the Claude Code hook looks for it.
const text = readFileSync('.env.example', 'utf8').replace(
  /^AGENTBRIDGE_DASHBOARD_PASSWORD=.*$/m,
  `AGENTBRIDGE_DASHBOARD_PASSWORD=${password}`,
);
writeFileSync('.env', text, { encoding: 'utf8', mode: 0o600 });

console.log('Created .env with a generated dashboard password.');
console.log('Your dashboard password is the AGENTBRIDGE_DASHBOARD_PASSWORD value in .env.');
console.log('Next: edit .env (PHONE_TO_NUMBER, TELEPHONY_PROVIDER, Twilio keys), then `npm run build && npm start`.');
