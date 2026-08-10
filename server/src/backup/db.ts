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
];

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
  runMigrations(db);
  return db;
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
