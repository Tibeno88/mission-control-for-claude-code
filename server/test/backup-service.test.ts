import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Config } from "../src/config.js";
import { openDb } from "../src/backup/db.js";
import { BackupService } from "../src/backup/service.js";
import type { SessionAgg, TranscriptStore } from "../src/transcripts.js";
import { emptyUsage } from "../src/types.js";

const SLUG_MAPPED = "-home-user-projects-mapped";
const SLUG_UNMAPPED = "-home-user-projects-unmapped";

function makeSession(
  sessionId: string,
  projectSlug: string,
  transcriptPath: string,
  overrides: Partial<SessionAgg> = {},
): SessionAgg {
  return {
    sessionId,
    projectSlug,
    transcriptPath,
    cwd: `/home/user/projects/${projectSlug}`,
    gitBranch: "main",
    models: new Set(["claude-fable-5"]),
    prompts: 3,
    usage: {
      ...emptyUsage(),
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWrite5mTokens: 5,
      cacheWrite1hTokens: 7,
    },
    costUSD: 0.5,
    subAgents: new Map(),
    subAgentCostUSD: 0.1,
    missing: false,
    ...overrides,
  };
}

/** Minimal fake exposing only what BackupService reads from TranscriptStore. */
function fakeStore(sessions: SessionAgg[]): TranscriptStore {
  return { sessions: () => sessions } as unknown as TranscriptStore;
}

describe("backup/service", () => {
  let root: string;
  let db: Database.Database;
  let projectsDir: string;
  let backupDir: string;
  let config: Config;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-service-"));
    db = openDb(path.join(root, "cmc.db"));
    projectsDir = path.join(root, "projects");
    backupDir = path.join(root, "archives");
    await fsp.mkdir(projectsDir, { recursive: true });
    await fsp.mkdir(backupDir, { recursive: true });
    config = {
      port: 0,
      claudeDir: root,
      projectsDir,
      sessionsDir: root,
      plannotatorSessionsDir: path.join(root, "plannotator"),
      scanDays: 7,
      registryPollMs: 3000,
      broadcastDebounceMs: 500,
      dataDir: root,
      dbPath: path.join(root, "cmc.db"),
      backupDir,
    };
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  async function writeTranscript(
    projectSlug: string,
    sessionId: string,
    content: string,
  ): Promise<string> {
    const dir = path.join(projectsDir, projectSlug);
    await fsp.mkdir(dir, { recursive: true });
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
    await fsp.writeFile(transcriptPath, content);
    return transcriptPath;
  }

  test("run('manual') snapshots sessions, resolves account via project map, and archives raws", async () => {
    const path1 = await writeTranscript(
      SLUG_MAPPED,
      "session-1",
      "content-one",
    );
    const path2 = await writeTranscript(
      SLUG_UNMAPPED,
      "session-2",
      "content-two",
    );
    const sessions = [
      makeSession("session-1", SLUG_MAPPED, path1),
      makeSession("session-2", SLUG_UNMAPPED, path2),
    ];
    const store = fakeStore(sessions);

    const { lastInsertRowid: accountId } = db
      .prepare(
        `INSERT INTO accounts (label, email, organization_name, color) VALUES ('Perso', NULL, NULL, '#123456')`,
      )
      .run();
    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)`,
    ).run(SLUG_MAPPED, accountId);
    // SLUG_UNMAPPED is intentionally left unmapped.

    const service = new BackupService(db, store, config);
    const seenStatuses: string[] = [];
    service.on("status", (event: { status: string }) => {
      seenStatuses.push(event.status);
    });

    const run = await service.run("manual");

    expect(run.sessionsCount).toBe(2);
    expect(run.finishedAt).not.toBeNull();
    expect(run.filesArchived).toBe(2);
    expect(seenStatuses).toEqual(["running", "done"]);

    const runRow = db
      .prepare("SELECT * FROM backup_runs WHERE id = ?")
      .get(run.id) as { finished_at: number | null; sessions_count: number };
    expect(runRow.finished_at).not.toBeNull();
    expect(runRow.sessions_count).toBe(2);

    const snapshots = db
      .prepare("SELECT * FROM session_snapshots ORDER BY session_id")
      .all() as Array<{
      session_id: string;
      project_slug: string;
      account_id: number | null;
      models: string;
      cache_write_tokens: number;
    }>;
    expect(snapshots).toHaveLength(2);

    const mappedSnapshot = snapshots.find(
      (row) => row.session_id === "session-1",
    )!;
    expect(mappedSnapshot.account_id).toBe(Number(accountId));
    expect(JSON.parse(mappedSnapshot.models)).toEqual(["claude-fable-5"]);
    // cache_write_tokens = cacheWrite5mTokens + cacheWrite1hTokens = 5 + 7
    expect(mappedSnapshot.cache_write_tokens).toBe(12);

    const unmappedSnapshot = snapshots.find(
      (row) => row.session_id === "session-2",
    )!;
    expect(unmappedSnapshot.account_id).toBeNull();
  });

  test("rejects a concurrent run while one is already in progress", async () => {
    const transcriptPath = await writeTranscript(
      SLUG_MAPPED,
      "session-1",
      "content",
    );
    const store = fakeStore([
      makeSession("session-1", SLUG_MAPPED, transcriptPath),
    ]);
    const service = new BackupService(db, store, config);

    const first = service.run("manual");
    await expect(service.run("manual")).rejects.toThrow(
      "a backup run is already in progress",
    );
    await first;
  });

  test("allows a new run once the previous one has finished", async () => {
    const transcriptPath = await writeTranscript(
      SLUG_MAPPED,
      "session-1",
      "content",
    );
    const store = fakeStore([
      makeSession("session-1", SLUG_MAPPED, transcriptPath),
    ]);
    const service = new BackupService(db, store, config);

    await service.run("manual");
    await expect(service.run("manual")).resolves.toBeDefined();
  });

  test("listRuns returns persisted runs, most recent first", async () => {
    const transcriptPath = await writeTranscript(
      SLUG_MAPPED,
      "session-1",
      "content",
    );
    const store = fakeStore([
      makeSession("session-1", SLUG_MAPPED, transcriptPath),
    ]);
    const service = new BackupService(db, store, config);

    const runA = await service.run("manual");
    const runB = await service.run("scheduled");

    const runs = service.listRuns(10);
    expect(runs.map((run) => run.id)).toEqual([runB.id, runA.id]);
    expect(runs[0]?.mode).toBe("scheduled");
  });
});
