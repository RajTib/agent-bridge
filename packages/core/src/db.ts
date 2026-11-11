import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ordered, append-only schema migrations. Never edit an applied migration;
 * add a new one. Each runs in a transaction and is recorded in
 * schema_migrations so startup is idempotent.
 */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,
        agent         TEXT NOT NULL,
        project_name  TEXT NOT NULL,
        cwd           TEXT,
        model         TEXT,
        status        TEXT NOT NULL CHECK (status IN ('active','ended')),
        started_at    TEXT NOT NULL,
        last_seen_at  TEXT NOT NULL,
        ended_at      TEXT,
        end_reason    TEXT
      );

      CREATE TABLE decisions (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        agent               TEXT NOT NULL,
        project_name        TEXT NOT NULL,
        cwd                 TEXT,
        tool_name           TEXT NOT NULL,
        summary             TEXT NOT NULL,
        spoken_summary      TEXT NOT NULL,
        detail              TEXT NOT NULL,
        risk                TEXT NOT NULL CHECK (risk IN ('low','medium','high')),
        risk_reasons        TEXT NOT NULL,
        dedupe_key          TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
        created_at          TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        resolved_at         TEXT,
        resolved_by         TEXT,
        resolution_channel  TEXT,
        resolution_note     TEXT,
        last_heartbeat_at   TEXT NOT NULL
      );
      CREATE INDEX idx_decisions_status ON decisions(status, created_at);
      CREATE INDEX idx_decisions_session ON decisions(session_id, created_at);
      -- At most one PENDING decision per identical (session, tool, input).
      CREATE UNIQUE INDEX idx_decisions_pending_dedupe ON decisions(dedupe_key) WHERE status = 'pending';

      CREATE TABLE calls (
        id                TEXT PRIMARY KEY,
        decision_id       TEXT NOT NULL REFERENCES decisions(id),
        provider          TEXT NOT NULL,
        is_real_call      INTEGER NOT NULL,
        provider_call_id  TEXT,
        to_masked         TEXT NOT NULL,
        attempt           INTEGER NOT NULL,
        status            TEXT NOT NULL,
        result            TEXT,
        prompt_seq        INTEGER NOT NULL DEFAULT 0,
        prompts_played    INTEGER NOT NULL DEFAULT 0,
        invalid_inputs    INTEGER NOT NULL DEFAULT 0,
        error             TEXT,
        created_at        TEXT NOT NULL,
        answered_at       TEXT,
        ended_at          TEXT
      );
      CREATE INDEX idx_calls_decision ON calls(decision_id);
      CREATE INDEX idx_calls_created ON calls(created_at);

      CREATE TABLE events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           TEXT NOT NULL,
        type         TEXT NOT NULL,
        level        TEXT NOT NULL,
        session_id   TEXT,
        decision_id  TEXT,
        call_id      TEXT,
        message      TEXT NOT NULL,
        data         TEXT
      );
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_decision ON events(decision_id);

      -- Replay protection: every accepted state-changing webhook is recorded once.
      CREATE TABLE processed_webhooks (
        key          TEXT PRIMARY KEY,
        processed_at TEXT NOT NULL
      );

      CREATE TABLE dashboard_sessions (
        token_hash  TEXT PRIMARY KEY,
        created_at  TEXT NOT NULL,
        expires_at  TEXT NOT NULL,
        user_agent  TEXT
      );
    `,
  },
];

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Db): number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const ran: number[] = [];
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
    ran.push(m.version);
  }
  return ran;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
