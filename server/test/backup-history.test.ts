import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { registerBackupRoutes } from "../src/backup/api.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/backup/db.js";
import { BackupScheduler } from "../src/backup/scheduler.js";
import { BackupService } from "../src/backup/service.js";
import type { TranscriptStore } from "../src/transcripts.js";

function fakeStore(): TranscriptStore {
  return { sessions: () => [] } as unknown as TranscriptStore;
}

async function json(res: Response): Promise<any> {
  return res.json();
}

describe("backup/history (GET /api/backup/history)", () => {
  let root: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-history-"));
    db = openDb(path.join(root, "cmc.db"));
    const backupDir = path.join(root, "archives");
    await fsp.mkdir(backupDir, { recursive: true });

    const config: Config = {
      port: 0,
      claudeDir: root,
      projectsDir: path.join(root, "projects"),
      sessionsDir: root,
      scanDays: 7,
      registryPollMs: 3000,
      broadcastDebounceMs: 500,
      dataDir: root,
      dbPath: path.join(root, "cmc.db"),
      backupDir,
    };
    const store = fakeStore();
    const service = new BackupService(db, store, config);
    const scheduler = new BackupScheduler(service, db, backupDir);

    app = new Hono();
    registerBackupRoutes(app, { db, service, scheduler, store, config });
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function insertRun(id: number, startedAt: number): void {
    db.prepare(
      `INSERT INTO backup_runs (id, started_at, finished_at, mode, sessions_count, files_archived, bytes_raw, bytes_gz)
       VALUES (?, ?, ?, 'manual', 1, 0, 0, 0)`,
    ).run(id, startedAt, startedAt);
  }

  function insertSnapshot(
    runId: number,
    sessionId: string,
    projectSlug: string,
    accountId: number | null,
    costUSD: number,
    lastTs: string,
  ): void {
    db.prepare(
      `INSERT INTO session_snapshots
         (run_id, session_id, project_slug, cwd, account_id, models,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost_usd, prompts, sub_agent_cost_usd, first_ts, last_ts)
       VALUES (?, ?, ?, NULL, ?, '[]', 10, 20, 0, 0, ?, 1, 0, ?, ?)`,
    ).run(runId, sessionId, projectSlug, accountId, costUSD, lastTs, lastTs);
  }

  test("dedupes repeated backups of the same session by keeping only the latest snapshot", async () => {
    const now = new Date().toISOString();
    insertRun(1, Date.now() - 1000);
    insertRun(2, Date.now());
    // Same session backed up twice across two runs — the second (higher id)
    // snapshot for session-1 should be the one counted in totals.
    insertSnapshot(1, "session-1", "slug-a", null, 1.0, now);
    insertSnapshot(2, "session-1", "slug-a", null, 2.5, now);

    const res = await app.request("/api/backup/history?period=all");
    expect(res.status).toBe(200);
    const body = await json(res);

    expect(body.totals.sessions).toBe(1);
    expect(body.totals.costUSD).toBeCloseTo(2.5, 10);
  });

  test("byAccount includes a 'Non assigné' bucket for accountId=null snapshots", async () => {
    const now = new Date().toISOString();
    insertRun(1, Date.now());
    insertSnapshot(1, "session-1", "slug-a", null, 1.5, now);

    const res = await app.request("/api/backup/history?period=all");
    const body = await json(res);

    const unassigned = body.byAccount.find(
      (row: { accountId: number | null }) => row.accountId === null,
    );
    expect(unassigned).toBeDefined();
    expect(unassigned.label).toBe("Non assigné");
    expect(unassigned.sessions).toBe(1);
  });

  test("filters by period: 'today' excludes snapshots older than midnight", async () => {
    insertRun(1, Date.now() - 2 * 24 * 60 * 60 * 1000);
    const oldTs = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    insertSnapshot(1, "session-old", "slug-a", null, 1.0, oldTs);

    insertRun(2, Date.now());
    const newTs = new Date().toISOString();
    insertSnapshot(2, "session-new", "slug-a", null, 2.0, newTs);

    const res = await app.request("/api/backup/history?period=today");
    const body = await json(res);
    expect(body.totals.sessions).toBe(1);
    expect(body.totals.costUSD).toBeCloseTo(2.0, 10);
  });

  test("filters by account", async () => {
    const now = new Date().toISOString();
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Perso", color: "#112233" }),
    });
    const { account } = await json(createRes);

    insertRun(1, Date.now());
    insertSnapshot(1, "session-1", "slug-a", account.id, 1.0, now);
    insertSnapshot(1, "session-2", "slug-b", null, 3.0, now);

    const res = await app.request(
      `/api/backup/history?period=all&account=${account.id}`,
    );
    const body = await json(res);
    expect(body.totals.sessions).toBe(1);
    expect(body.totals.costUSD).toBeCloseTo(1.0, 10);
  });

  test("filters by project", async () => {
    const now = new Date().toISOString();
    insertRun(1, Date.now());
    insertSnapshot(1, "session-1", "slug-a", null, 1.0, now);
    insertSnapshot(1, "session-2", "slug-b", null, 3.0, now);

    const res = await app.request(
      "/api/backup/history?period=all&project=slug-b",
    );
    const body = await json(res);
    expect(body.totals.sessions).toBe(1);
    expect(body.byProject).toHaveLength(1);
    expect(body.byProject[0].projectSlug).toBe("slug-b");
  });

  test("400s on a non-numeric account filter", async () => {
    const res = await app.request(
      "/api/backup/history?period=all&account=not-a-number",
    );
    expect(res.status).toBe(400);
  });
});
