import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { BackupConfig } from "./types.js";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS backup_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    mode TEXT NOT NULL,
    sessions_count INTEGER NOT NULL DEFAULT 0,
    files_archived INTEGER NOT NULL DEFAULT 0,
    bytes_raw INTEGER NOT NULL DEFAULT 0,
    bytes_gz INTEGER NOT NULL DEFAULT 0,
    error TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS session_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    cwd TEXT,
    git_branch TEXT,
    account_id INTEGER,
    models TEXT NOT NULL DEFAULT '[]',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    prompts INTEGER NOT NULL DEFAULT 0,
    sub_agent_cost_usd REAL NOT NULL DEFAULT 0,
    first_ts TEXT,
    last_ts TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_session_snapshots_session_id ON session_snapshots (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_snapshots_run_id ON session_snapshots (run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_snapshots_project_slug ON session_snapshots (project_slug)`,
  `CREATE TABLE IF NOT EXISTS archives (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    project_slug TEXT NOT NULL,
    original_path TEXT NOT NULL,
    archive_path TEXT NOT NULL,
    sha256 TEXT NOT NULL UNIQUE,
    bytes_raw INTEGER NOT NULL DEFAULT 0,
    bytes_gz INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_archives_session_id ON archives (session_id)`,
  `CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    label TEXT NOT NULL,
    email TEXT,
    organization_name TEXT,
    color TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS project_account_map (
    project_slug TEXT PRIMARY KEY,
    account_id INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS backup_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // Fact table: one row per billable LLM request. Deliberately NOT linked to
  // backup_runs/run_id — applyRetention() cascades deletes from that chain, and
  // this table must survive purges by construction (it's the long memory, the
  // .gz archives are only the replayable source). account_id is frozen at write
  // time so a later project_account_map edit never rewrites historical cost.
  // agent_id defaults to '' (not NULL) for the main session — SQLite's UNIQUE
  // constraint treats NULL as distinct from NULL, which would silently defeat
  // dedup on every main-session row (the majority of them).
  `CREATE TABLE IF NOT EXISTS request_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL DEFAULT '',
    project_slug TEXT NOT NULL,
    account_id INTEGER,
    model TEXT NOT NULL,
    ts TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    rate_input REAL,
    rate_output REAL,
    rate_cache_read REAL,
    rate_cache_write_5m REAL,
    rate_cache_write_1h REAL,
    pricing_source TEXT,
    dedupe_key TEXT NOT NULL,
    UNIQUE (session_id, agent_id, dedupe_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_request_events_ts ON request_events (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_request_events_model ON request_events (model)`,
  // Compaction target for purged periods: month x model x project, requests
  // preserved as the denominator so avg cost/tokens per request stay exact
  // after compaction. NULL project_slug means "all projects" for that bucket.
  // Upserted on (bucket, model, project_slug) so compaction runs are re-entrant.
  `CREATE TABLE IF NOT EXISTS request_rollups (
    bucket TEXT NOT NULL,
    model TEXT NOT NULL,
    project_slug TEXT,
    requests INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    compacted_at INTEGER NOT NULL,
    PRIMARY KEY (bucket, model, project_slug)
  )`,
  // Single-row marker: request_events is complete only for ts >= purged_before.
  // Before that point, request_events may be incomplete (rows compacted away)
  // and callers must fall back to request_rollups.
  `CREATE TABLE IF NOT EXISTS purge_watermark (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    purged_before TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  // Kanban tasks: headless `claude -p` runs driven from the UI (see tasks/).
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prompt TEXT NOT NULL,
    cwd TEXT NOT NULL,
    model TEXT,
    permission_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    last_result TEXT,
    error TEXT,
    cost_usd REAL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
];

/** ALTERs applied after CREATE TABLE migrations — additive, safe to re-run. */
const COLUMN_MIGRATIONS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  {
    table: "session_snapshots",
    column: "cache_write_5m_tokens",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "session_snapshots",
    column: "cache_write_1h_tokens",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0",
  },
  {
    table: "session_snapshots",
    column: "rate_input",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN rate_input REAL",
  },
  {
    table: "session_snapshots",
    column: "rate_output",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN rate_output REAL",
  },
  {
    table: "session_snapshots",
    column: "rate_cache_read",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN rate_cache_read REAL",
  },
  {
    table: "session_snapshots",
    column: "rate_cache_write_5m",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN rate_cache_write_5m REAL",
  },
  {
    table: "session_snapshots",
    column: "rate_cache_write_1h",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN rate_cache_write_1h REAL",
  },
  {
    table: "session_snapshots",
    column: "pricing_source",
    ddl: "ALTER TABLE session_snapshots ADD COLUMN pricing_source TEXT",
  },
];

interface TableColumnRow {
  name: string;
}

function runColumnMigrations(db: Database.Database): void {
  for (const migration of COLUMN_MIGRATIONS) {
    const columns = db
      .prepare(`PRAGMA table_info(${migration.table})`)
      .all() as TableColumnRow[];
    const exists = columns.some((col) => col.name === migration.column);
    if (!exists) db.exec(migration.ddl);
  }
}

/** Default backup configuration used to seed `backup_config` on first run. */
export function defaultBackupConfig(backupDir: string): BackupConfig {
  return {
    enabled: false,
    cron: "0 * * * *",
    retentionDays: 0,
    backupDir,
  };
}

function runMigrations(db: Database.Database): void {
  db.transaction(() => {
    for (const statement of MIGRATIONS) db.exec(statement);
    runColumnMigrations(db);
  })();
}

/**
 * Opens (creating if absent) the CMC SQLite database, ensures WAL mode and
 * applies idempotent migrations. Creates the parent data directory if needed.
 */
export function openDb(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  // NORMAL is the standard pairing with WAL: still durable against app crashes,
  // avoids an fsync on every single request_events insert at ingestion time.
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  return db;
}

interface AccountMapRow {
  account_id: number | null;
}

/** Looks up the manually-mapped account for a project, or null if unmapped. */
export function resolveAccountId(
  db: Database.Database,
  projectSlug: string,
): number | null {
  const row = db
    .prepare(
      "SELECT account_id FROM project_account_map WHERE project_slug = ?",
    )
    .get(projectSlug) as AccountMapRow | undefined;
  return row?.account_id ?? null;
}

interface ConfigRow {
  value: string;
}

/** Reads `backup_config`, falling back to defaults for any missing key. */
export function getBackupConfig(
  db: Database.Database,
  fallbackBackupDir: string,
): BackupConfig {
  const defaults = defaultBackupConfig(fallbackBackupDir);
  const rows = db
    .prepare("SELECT key, value FROM backup_config")
    .all() as Array<ConfigRow & { key: string }>;
  const map = new Map(rows.map((row) => [row.key, row.value]));

  const enabledRaw = map.get("enabled");
  const retentionRaw = map.get("retentionDays");
  return {
    enabled:
      enabledRaw === undefined ? defaults.enabled : enabledRaw === "true",
    cron: map.get("cron") ?? defaults.cron,
    retentionDays:
      retentionRaw === undefined
        ? defaults.retentionDays
        : Number.parseInt(retentionRaw, 10),
    backupDir: map.get("backupDir") ?? defaults.backupDir,
  };
}

/** Persists a partial `BackupConfig` into `backup_config` (upsert per key). */
export function setBackupConfig(
  db: Database.Database,
  patch: Partial<BackupConfig>,
): void {
  const upsert = db.prepare(
    `INSERT INTO backup_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  db.transaction(() => {
    if (patch.enabled !== undefined)
      upsert.run("enabled", patch.enabled ? "true" : "false");
    if (patch.cron !== undefined) upsert.run("cron", patch.cron);
    if (patch.retentionDays !== undefined)
      upsert.run("retentionDays", String(patch.retentionDays));
    if (patch.backupDir !== undefined) upsert.run("backupDir", patch.backupDir);
  })();
}
