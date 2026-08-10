import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../src/backup/db.js";
import { applyRetention } from "../src/backup/retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("backup/retention", () => {
  let root: string;
  let db: Database.Database;
  let backupDir: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-retention-"));
    db = openDb(path.join(root, "cmc.db"));
    backupDir = path.join(root, "archives");
    await fsp.mkdir(backupDir, { recursive: true });
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function insertRun(id: number, finishedAt: number | null): void {
    db.prepare(
      `INSERT INTO backup_runs (id, started_at, finished_at, mode, sessions_count, files_archived, bytes_raw, bytes_gz)
       VALUES (?, ?, ?, 'manual', 0, 0, 0, 0)`,
    ).run(id, finishedAt ?? Date.now(), finishedAt);
  }

  async function insertArchive(
    id: number,
    runId: number,
    archivedAt: number,
    archivePath: string,
  ): Promise<void> {
    await fsp.writeFile(archivePath, "gz-content");
    db.prepare(
      `INSERT INTO archives
         (id, run_id, session_id, project_slug, original_path, archive_path, sha256, bytes_raw, bytes_gz, archived_at)
       VALUES (?, ?, 'session', 'slug', 'orig.jsonl', ?, ?, 10, 5, ?)`,
    ).run(id, runId, archivePath, `sha-${id}`, archivedAt);
  }

  test("is a no-op when retentionDays <= 0", async () => {
    insertRun(1, Date.now() - 30 * DAY_MS);
    const oldArchivePath = path.join(backupDir, "old.jsonl.gz");
    await insertArchive(1, 1, Date.now() - 30 * DAY_MS, oldArchivePath);

    await applyRetention(db, backupDir, 0);
    await applyRetention(db, backupDir, -5);

    const rows = db.prepare("SELECT * FROM archives").all();
    expect(rows).toHaveLength(1);
    await expect(fsp.access(oldArchivePath)).resolves.toBeUndefined();
  });

  test("deletes archive rows and gz files older than the retention threshold", async () => {
    insertRun(1, Date.now() - 30 * DAY_MS);
    insertRun(2, Date.now() - 1 * DAY_MS);

    const oldPath = path.join(backupDir, "old.jsonl.gz");
    const recentPath = path.join(backupDir, "recent.jsonl.gz");
    await insertArchive(1, 1, Date.now() - 30 * DAY_MS, oldPath);
    await insertArchive(2, 2, Date.now() - 1 * DAY_MS, recentPath);

    await applyRetention(db, backupDir, 7);

    const rows = db.prepare("SELECT id FROM archives").all() as Array<{
      id: number;
    }>;
    expect(rows.map((row) => row.id)).toEqual([2]);

    await expect(fsp.access(oldPath)).rejects.toThrow();
    await expect(fsp.access(recentPath)).resolves.toBeUndefined();
  });

  test("purges session_snapshots and backup_runs once their archives have aged out", async () => {
    insertRun(1, Date.now() - 30 * DAY_MS);
    const oldPath = path.join(backupDir, "old.jsonl.gz");
    await insertArchive(1, 1, Date.now() - 30 * DAY_MS, oldPath);
    db.prepare(
      `INSERT INTO session_snapshots (run_id, session_id, project_slug, models)
       VALUES (1, 'session', 'slug', '[]')`,
    ).run();

    await applyRetention(db, backupDir, 7);

    // Archives pruned by age, and the now-orphaned run + snapshot rows follow.
    expect(db.prepare("SELECT * FROM archives").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM session_snapshots").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM backup_runs").all()).toHaveLength(0);
  });

  test("keeps a recent run and its snapshots even when it has no archives", async () => {
    // A deduped run legitimately has zero archives; being newer than the cutoff
    // it must survive retention.
    insertRun(1, Date.now() - 1 * DAY_MS);
    db.prepare(
      `INSERT INTO session_snapshots (run_id, session_id, project_slug, models)
       VALUES (1, 'session', 'slug', '[]')`,
    ).run();

    await applyRetention(db, backupDir, 7);

    expect(db.prepare("SELECT * FROM session_snapshots").all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM backup_runs").all()).toHaveLength(1);
  });

  test("confines deletion to backupDir and does not remove files with a matching sha but outside it", async () => {
    insertRun(1, Date.now() - 30 * DAY_MS);
    const outsideDir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "cmc-backup-retention-outside-"),
    );
    const outsidePath = path.join(outsideDir, "sneaky.jsonl.gz");
    await fsp.writeFile(outsidePath, "gz-content");
    db.prepare(
      `INSERT INTO archives
         (id, run_id, session_id, project_slug, original_path, archive_path, sha256, bytes_raw, bytes_gz, archived_at)
       VALUES (1, 1, 'session', 'slug', 'orig.jsonl', ?, 'sha-outside', 10, 5, ?)`,
    ).run(outsidePath, Date.now() - 30 * DAY_MS);

    await applyRetention(db, backupDir, 7);

    // The DB row is still removed (retention drops stale rows regardless of
    // path), but the file itself — living outside backupDir — is untouched.
    expect(db.prepare("SELECT * FROM archives").all()).toHaveLength(0);
    await expect(fsp.access(outsidePath)).resolves.toBeUndefined();

    await fsp.rm(outsideDir, { recursive: true, force: true });
  });

  test("does not throw when the gz file is already missing on disk", async () => {
    insertRun(1, Date.now() - 30 * DAY_MS);
    const missingPath = path.join(backupDir, "already-gone.jsonl.gz");
    db.prepare(
      `INSERT INTO archives
         (id, run_id, session_id, project_slug, original_path, archive_path, sha256, bytes_raw, bytes_gz, archived_at)
       VALUES (1, 1, 'session', 'slug', 'orig.jsonl', ?, 'sha-missing', 10, 5, ?)`,
    ).run(missingPath, Date.now() - 30 * DAY_MS);

    await expect(applyRetention(db, backupDir, 7)).resolves.toBeUndefined();
    expect(db.prepare("SELECT * FROM archives").all()).toHaveLength(0);
  });
});
