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

describe("backup/api", () => {
  let root: string;
  let db: Database.Database;
  let app: Hono;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-api-"));
    db = openDb(path.join(root, "cmc.db"));
    const backupDir = path.join(root, "archives");
    await fsp.mkdir(backupDir, { recursive: true });

    const config: Config = {
      port: 0,
      claudeDir: root,
      projectsDir: path.join(root, "projects"),
      sessionsDir: root,
      plannotatorSessionsDir: path.join(root, "plannotator"),
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

  describe("POST /api/accounts", () => {
    test("400s when label is missing", async () => {
      const res = await app.request("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ color: "#112233" }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toMatch(/label/i);
    });

    test("400s when color does not match #RRGGBB", async () => {
      const res = await app.request("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Perso", color: "blue" }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toMatch(/color/i);
    });

    test("creates an account with valid label and color", async () => {
      const res = await app.request("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Perso",
          color: "#a1B2c3",
          email: "me@example.com",
        }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.account.label).toBe("Perso");
      expect(body.account.color).toBe("#a1B2c3");
      expect(body.account.email).toBe("me@example.com");
      expect(typeof body.account.id).toBe("number");
    });
  });

  test("GET /api/accounts lists created accounts", async () => {
    await app.request("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Perso", color: "#112233" }),
    });

    const res = await app.request("/api/accounts");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.accounts).toHaveLength(1);
    expect(body.accounts[0].label).toBe("Perso");
  });

  test("DELETE /api/accounts/:id removes the account and nulls project_account_map entries", async () => {
    const createRes = await app.request("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Perso", color: "#112233" }),
    });
    const { account } = await json(createRes);

    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES ('slug-a', ?)`,
    ).run(account.id);

    const delRes = await app.request(`/api/accounts/${account.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect((await json(delRes)).ok).toBe(true);

    const accountsRes = await app.request("/api/accounts");
    expect((await json(accountsRes)).accounts).toHaveLength(0);

    const mapRow = db
      .prepare(
        "SELECT account_id FROM project_account_map WHERE project_slug = 'slug-a'",
      )
      .get() as { account_id: number | null };
    expect(mapRow.account_id).toBeNull();
  });

  test("DELETE /api/accounts/:id 400s on a non-numeric id", async () => {
    const res = await app.request("/api/accounts/not-a-number", {
      method: "DELETE",
    });
    expect(res.status).toBe(400);
  });

  describe("PUT/GET /api/project-map", () => {
    test("PUT upserts a mapping row queryable directly in project_account_map", async () => {
      const createRes = await app.request("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Pro", color: "#445566" }),
      });
      const { account } = await json(createRes);

      const putRes = await app.request("/api/project-map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSlug: "slug-b",
          accountId: account.id,
        }),
      });
      expect(putRes.status).toBe(200);

      const mapRow = db
        .prepare(
          "SELECT account_id FROM project_account_map WHERE project_slug = 'slug-b'",
        )
        .get() as { account_id: number };
      expect(mapRow.account_id).toBe(account.id);

      const getRes = await app.request("/api/project-map");
      expect(getRes.status).toBe(200);
      const body = await json(getRes);
      expect(Array.isArray(body.entries)).toBe(true);
    });

    test("PUT 400s when accountId does not exist", async () => {
      const res = await app.request("/api/project-map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectSlug: "slug-c", accountId: 999999 }),
      });
      expect(res.status).toBe(400);
    });

    test("PUT 400s when projectSlug is missing", async () => {
      const res = await app.request("/api/project-map", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: null }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET/PUT /api/backup/config", () => {
    test("GET returns the default config", async () => {
      const res = await app.request("/api/backup/config");
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.enabled).toBe(false);
      expect(body.retentionDays).toBe(0);
    });

    test("PUT with a valid cron updates the config", async () => {
      const res = await app.request("/api/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "*/10 * * * *", retentionDays: 30 }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.cron).toBe("*/10 * * * *");
      expect(body.retentionDays).toBe(30);
    });

    test("PUT with an invalid cron expression returns 400", async () => {
      const res = await app.request("/api/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cron: "not a cron expression" }),
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.error).toMatch(/cron/i);
    });

    test("PUT with a negative retentionDays returns 400", async () => {
      const res = await app.request("/api/backup/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: -1 }),
      });
      expect(res.status).toBe(400);
    });
  });

  test("POST /api/backup/run triggers a run and returns { run }", async () => {
    const res = await app.request("/api/backup/run", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.run).toBeDefined();
    expect(body.run.mode).toBe("manual");
    expect(body.run.finishedAt).not.toBeNull();
  });

  test("GET /api/backup/runs returns persisted runs after a manual run", async () => {
    await app.request("/api/backup/run", { method: "POST" });
    const res = await app.request("/api/backup/runs");
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.runs).toHaveLength(1);
  });

  test("GET /api/archives 400s on an invalid session id", async () => {
    const res = await app.request("/api/archives?sessionId=not valid");
    expect(res.status).toBe(400);
  });

  test("GET /api/archives returns an empty list for a valid but unknown session id", async () => {
    const res = await app.request(
      "/api/archives?sessionId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.archives).toEqual([]);
  });
});
