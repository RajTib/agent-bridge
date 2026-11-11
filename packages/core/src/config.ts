import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_PORT, type PublicConfigSummary, type RiskLevel } from '@agentbridge/shared';

const E164 = /^\+[1-9]\d{6,14}$/;

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const intIn = (min: number, max: number, def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return def;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  AGENTBRIDGE_HOST: optionalString,
  AGENTBRIDGE_PORT: intIn(1, 65535, DEFAULT_PORT),
  AGENTBRIDGE_DATA_DIR: optionalString,
  AGENTBRIDGE_PUBLIC_URL: optionalString,
  AGENTBRIDGE_HOOK_TOKEN: optionalString,
  AGENTBRIDGE_DASHBOARD_PASSWORD: optionalString,
  AGENTBRIDGE_TRUST_PROXY: bool,
  AGENTBRIDGE_EXPOSE_DASHBOARD: bool,
  AGENTBRIDGE_LOG_LEVEL: optionalString,
  AGENTBRIDGE_DASHBOARD_DIR: optionalString,

  APPROVAL_TIMEOUT_SECONDS: intIn(15, 3600, 300),
  APPROVAL_TIMEOUT_BEHAVIOR: z.enum(['ask', 'deny']).optional().default('ask'),
  HOOK_HEARTBEAT_GRACE_SECONDS: intIn(10, 600, 60),

  TELEPHONY_PROVIDER: z.enum(['none', 'mock', 'twilio']).optional().default('mock'),
  PHONE_TO_NUMBER: optionalString,
  TRUSTED_PHONE_NUMBERS: optionalString,
  CALL_MIN_RISK: z.enum(['low', 'medium', 'high']).optional().default('low'),
  CALL_RING_TIMEOUT_SECONDS: intIn(10, 120, 30),
  CALL_MAX_ATTEMPTS: intIn(1, 5, 2),
  CALL_RETRY_DELAY_SECONDS: intIn(0, 600, 30),
  DTMF_MAX_PROMPTS: intIn(1, 6, 3),
  DTMF_INPUT_TIMEOUT_SECONDS: intIn(3, 30, 8),
  TTS_VOICE: optionalString,
  TTS_LANGUAGE: optionalString,

  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_FROM_NUMBER: optionalString,
  TWILIO_API_BASE: optionalString,

  DISCORD_WEBHOOK_URL: optionalString,
  DISCORD_EVENTS: optionalString,
});

export type TelephonyProviderName = 'none' | 'mock' | 'twilio';

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  /** Public HTTPS base URL that the telephony provider can reach (e.g. a cloudflared tunnel). */
  publicUrl: string | null;
  /** Explicit hook token; when absent the server generates one in dataDir. */
  hookToken: string | null;
  /** Explicit dashboard password; when absent the server generates one in dataDir. */
  dashboardPassword: string | null;
  trustProxy: boolean;
  /** Allow the dashboard (never the hook API) to be reached through the public tunnel. */
  exposeDashboard: boolean;
  logLevel: string;
  dashboardDir: string | null;

  approvalTimeoutSeconds: number;
  timeoutBehavior: 'ask' | 'deny';
  heartbeatGraceSeconds: number;

  telephony: {
    provider: TelephonyProviderName;
    toNumber: string | null;
    trustedNumbers: string[];
    minRisk: RiskLevel;
    ringTimeoutSeconds: number;
    maxAttempts: number;
    retryDelaySeconds: number;
    dtmfMaxPrompts: number;
    dtmfInputTimeoutSeconds: number;
    voice: string;
    language: string;
  };
  twilio: {
    accountSid: string | null;
    authToken: string | null;
    fromNumber: string | null;
    apiBase: string;
  };
  discord: {
    webhookUrl: string | null;
    /** null = all supported events. */
    events: string[] | null;
  };
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid AgentBridge configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

function expandHome(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p;
}

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Loads configuration from environment variables only (secrets never live in
 * files that might be committed). Throws ConfigError listing every problem at
 * once so a misconfigured setup can be fixed in one pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const problems: string[] = [];

  const dataDir = resolve(expandHome(e.AGENTBRIDGE_DATA_DIR ?? '~/.agentbridge'));

  let publicUrl: string | null = null;
  if (e.AGENTBRIDGE_PUBLIC_URL) {
    try {
      const u = new URL(e.AGENTBRIDGE_PUBLIC_URL);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        problems.push('AGENTBRIDGE_PUBLIC_URL must use https (telephony webhooks carry approval decisions)');
      }
      publicUrl = u.toString().replace(/\/+$/, '');
    } catch {
      problems.push('AGENTBRIDGE_PUBLIC_URL is not a valid URL');
    }
  }

  const toNumber = e.PHONE_TO_NUMBER ?? null;
  if (toNumber && !E164.test(toNumber)) problems.push('PHONE_TO_NUMBER must be E.164, e.g. +919876543210');
  const trusted = splitList(e.TRUSTED_PHONE_NUMBERS);
  for (const n of trusted) if (!E164.test(n)) problems.push(`TRUSTED_PHONE_NUMBERS entry "${n}" is not E.164`);
  // With no explicit allow-list, the single configured destination is the only trusted number.
  const trustedNumbers = trusted.length > 0 ? trusted : toNumber ? [toNumber] : [];
  if (toNumber && !trustedNumbers.includes(toNumber)) {
    problems.push('PHONE_TO_NUMBER is not in TRUSTED_PHONE_NUMBERS');
  }

  if (e.TWILIO_FROM_NUMBER && !E164.test(e.TWILIO_FROM_NUMBER)) {
    problems.push('TWILIO_FROM_NUMBER must be E.164');
  }

  if (e.AGENTBRIDGE_DASHBOARD_PASSWORD && e.AGENTBRIDGE_DASHBOARD_PASSWORD.length < 12) {
    problems.push('AGENTBRIDGE_DASHBOARD_PASSWORD must be at least 12 characters');
  }
  if (e.AGENTBRIDGE_HOOK_TOKEN && e.AGENTBRIDGE_HOOK_TOKEN.length < 32) {
    problems.push('AGENTBRIDGE_HOOK_TOKEN must be at least 32 characters (leave it unset to auto-generate one)');
  }

  if (e.DISCORD_WEBHOOK_URL) {
    try {
      const u = new URL(e.DISCORD_WEBHOOK_URL);
      if (u.protocol !== 'https:') problems.push('DISCORD_WEBHOOK_URL must be https');
    } catch {
      problems.push('DISCORD_WEBHOOK_URL is not a valid URL');
    }
  }

  if (problems.length) throw new ConfigError(problems);

  return {
    host: e.AGENTBRIDGE_HOST ?? '127.0.0.1',
    port: e.AGENTBRIDGE_PORT,
    dataDir,
    dbPath: join(dataDir, 'agentbridge.db'),
    publicUrl,
    hookToken: e.AGENTBRIDGE_HOOK_TOKEN ?? null,
    dashboardPassword: e.AGENTBRIDGE_DASHBOARD_PASSWORD ?? null,
    trustProxy: e.AGENTBRIDGE_TRUST_PROXY ?? false,
    exposeDashboard: e.AGENTBRIDGE_EXPOSE_DASHBOARD ?? false,
    logLevel: e.AGENTBRIDGE_LOG_LEVEL ?? 'info',
    dashboardDir: e.AGENTBRIDGE_DASHBOARD_DIR ?? null,
    approvalTimeoutSeconds: e.APPROVAL_TIMEOUT_SECONDS,
    timeoutBehavior: e.APPROVAL_TIMEOUT_BEHAVIOR,
    heartbeatGraceSeconds: e.HOOK_HEARTBEAT_GRACE_SECONDS,
    telephony: {
      provider: e.TELEPHONY_PROVIDER,
      toNumber,
      trustedNumbers,
      minRisk: e.CALL_MIN_RISK,
      ringTimeoutSeconds: e.CALL_RING_TIMEOUT_SECONDS,
      maxAttempts: e.CALL_MAX_ATTEMPTS,
      retryDelaySeconds: e.CALL_RETRY_DELAY_SECONDS,
      dtmfMaxPrompts: e.DTMF_MAX_PROMPTS,
      dtmfInputTimeoutSeconds: e.DTMF_INPUT_TIMEOUT_SECONDS,
      voice: e.TTS_VOICE ?? 'Polly.Aditi',
      language: e.TTS_LANGUAGE ?? 'en-IN',
    },
    twilio: {
      accountSid: e.TWILIO_ACCOUNT_SID ?? null,
      authToken: e.TWILIO_AUTH_TOKEN ?? null,
      fromNumber: e.TWILIO_FROM_NUMBER ?? null,
      apiBase: e.TWILIO_API_BASE ?? 'https://api.twilio.com',
    },
    discord: {
      webhookUrl: e.DISCORD_WEBHOOK_URL ?? null,
      events: e.DISCORD_EVENTS ? splitList(e.DISCORD_EVENTS) : null,
    },
  };
}

export function publicConfigSummary(c: AppConfig): PublicConfigSummary {
  return {
    approvalTimeoutSeconds: c.approvalTimeoutSeconds,
    timeoutBehavior: c.timeoutBehavior,
    callMinRisk: c.telephony.minRisk,
    callMaxAttempts: c.telephony.maxAttempts,
    dtmfMaxPrompts: c.telephony.dtmfMaxPrompts,
    ringTimeoutSeconds: c.telephony.ringTimeoutSeconds,
    voice: c.telephony.voice,
    language: c.telephony.language,
  };
}
