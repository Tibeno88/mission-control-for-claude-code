import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  defaultBackupConfig,
  getBackupConfig,
  openDb,
  setBackupConfig,
} from "../src/backup/db.js";

const EXPECTED_TABLES = [
  "backup_runs",
  "session_snapshots",
  "archives",
  "accounts",
  "project_account_map",
  "backup_config",
];

describe("backup/db", () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-db-"));
    dbPath = path.join(root, "nested", "cmc.db");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("creates the data directory and the sqlite file", async () => {
    await expect(fsp.access(dbPath)).rejects.toThrow();
    const db = openDb(dbPath);
    db.close();
    await expect(fsp.access(dbPath)).resolves.toBeUndefined();
  });

  test("creates all expected tables via migrations", () => {
    const db = openDb(dbPath);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = rows.map((row) => row.name);
    for (const table of EXPECTED_TABLES) {
      expect(names).toContain(table);
    }
    db.close();
  });

  test("re-opening the same database file does not throw (idempotent migrations)", () => {
    const first = openDb(dbPath);
    first.close();

    expect(() => {
      const second = openDb(dbPath);
      second.close();
    }).not.toThrow();
  });

  test("adds the advisor and kind columns and keeps them across re-opens", () => {
    const first = openDb(dbPath);
    first.close();
    const db = openDb(dbPath);

    const columnsOf = (table: string): string[] =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name: string;
        }>
      ).map((col) => col.name);
    expect(columnsOf("request_events")).toContain("kind");
    expect(columnsOf("session_snapshots")).toEqual(
      expect.arrayContaining(["advisor_calls", "advisor_cost_usd"]),
    );
    db.close();
  });

  test("getBackupConfig returns defaults when backup_config is empty", () => {
    const db = openDb(dbPath);
    const fallbackDir = path.join(root, "fallback-archives");
    const config = getBackupConfig(db, fallbackDir);
    expect(config).toEqual(defaultBackupConfig(fallbackDir));
    db.close();
  });

  test("setBackupConfig persists a partial patch and round-trips via getBackupConfig", () => {
    const db = openDb(dbPath);
    const fallbackDir = path.join(root, "fallback-archives");

    setBackupConfig(db, { enabled: true, retentionDays: 14 });
    const config = getBackupConfig(db, fallbackDir);

    expect(config.enabled).toBe(true);
    expect(config.retentionDays).toBe(14);
    // Untouched keys still fall back to defaults.
    expect(config.cron).toBe(defaultBackupConfig(fallbackDir).cron);
    expect(config.backupDir).toBe(fallbackDir);

    // A second partial patch only overrides the given keys.
    setBackupConfig(db, { cron: "*/5 * * * *" });
    const updated = getBackupConfig(db, fallbackDir);
    expect(updated.cron).toBe("*/5 * * * *");
    expect(updated.enabled).toBe(true); // unchanged from previous patch
    expect(updated.retentionDays).toBe(14); // unchanged from previous patch

    db.close();
  });

  test("inserts and reads back an account row", () => {
    const db: Database.Database = openDb(dbPath);
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO accounts (label, email, organization_name, color) VALUES (?, ?, ?, ?)`,
      )
      .run("Perso", "me@example.com", "Acme", "#112233");

    const row = db
      .prepare("SELECT * FROM accounts WHERE id = ?")
      .get(lastInsertRowid) as {
      id: number;
      label: string;
      email: string | null;
      organization_name: string | null;
      color: string;
    };

    expect(row.label).toBe("Perso");
    expect(row.email).toBe("me@example.com");
    expect(row.organization_name).toBe("Acme");
    expect(row.color).toBe("#112233");

    db.close();
  });
});
