import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { archiveTranscript } from "../src/backup/archive.js";
import { openDb } from "../src/backup/db.js";
import type { SessionAgg } from "../src/transcripts.js";
import { emptyUsage } from "../src/types.js";

const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SLUG = "-home-user-projects-demo";

function makeSession(transcriptPath: string): SessionAgg {
  return {
    sessionId: SESSION_ID,
    projectSlug: SLUG,
    transcriptPath,
    cwd: "/home/user/projects/demo",
    gitBranch: "main",
    models: new Set(["claude-fable-5"]),
    prompts: 1,
    usage: emptyUsage(),
    costUSD: 0,
    subAgents: new Map(),
    subAgentCostUSD: 0,
    advisorCalls: 0,
    advisorCostUSD: 0,
    missing: false,
  };
}

describe("backup/archive", () => {
  let root: string;
  let db: Database.Database;
  let projectsDir: string;
  let backupDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-backup-archive-"));
    db = openDb(path.join(root, "cmc.db"));
    projectsDir = path.join(root, "projects");
    backupDir = path.join(root, "archives");
    const projectDir = path.join(projectsDir, SLUG);
    await fsp.mkdir(projectDir, { recursive: true });
    transcriptPath = path.join(projectDir, `${SESSION_ID}.jsonl`);
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("gzips the transcript, records an archives row, and gz is smaller than raw", async () => {
    const content = JSON.stringify({ type: "user", text: "a".repeat(5000) });
    await fsp.writeFile(transcriptPath, content);
    const session = makeSession(transcriptPath);

    const result = await archiveTranscript(
      db,
      1,
      session,
      backupDir,
      projectsDir,
    );

    expect(result.filesArchived).toBe(1);
    expect(result.bytesRaw).toBe(Buffer.byteLength(content));
    expect(result.bytesGz).toBeGreaterThan(0);
    expect(result.bytesGz).toBeLessThan(result.bytesRaw);

    const rows = db.prepare("SELECT * FROM archives").all() as Array<{
      session_id: string;
      project_slug: string;
      archive_path: string;
      sha256: string;
      bytes_raw: number;
      bytes_gz: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe(SESSION_ID);
    expect(rows[0]!.project_slug).toBe(SLUG);
    expect(rows[0]!.bytes_raw).toBe(Buffer.byteLength(content));

    const gzBuffer = await fsp.readFile(rows[0]!.archive_path);
    expect(zlib.gunzipSync(gzBuffer).toString("utf8")).toBe(content);
  });

  test("second archive of identical content is deduplicated (no new file, no duplicate sha256)", async () => {
    const content = JSON.stringify({ type: "user", text: "same content" });
    await fsp.writeFile(transcriptPath, content);
    const session = makeSession(transcriptPath);

    const first = await archiveTranscript(
      db,
      1,
      session,
      backupDir,
      projectsDir,
    );
    expect(first.filesArchived).toBe(1);

    const second = await archiveTranscript(
      db,
      2,
      session,
      backupDir,
      projectsDir,
    );
    expect(second.filesArchived).toBe(0);
    expect(second.bytesRaw).toBe(0);
    expect(second.bytesGz).toBe(0);

    const rows = db.prepare("SELECT sha256 FROM archives").all() as Array<{
      sha256: string;
    }>;
    expect(rows).toHaveLength(1);
    const shas = new Set(rows.map((row) => row.sha256));
    expect(shas.size).toBe(1);
  });

  test("tolerates a missing transcript file without crashing", async () => {
    // transcriptPath is never written — file does not exist on disk.
    const session = makeSession(transcriptPath);

    const result = await archiveTranscript(
      db,
      1,
      session,
      backupDir,
      projectsDir,
    );

    expect(result.filesArchived).toBe(0);
    expect(result.bytesRaw).toBe(0);
    expect(result.bytesGz).toBe(0);
    const rows = db.prepare("SELECT * FROM archives").all();
    expect(rows).toHaveLength(0);
  });

  test("archives sub-agent transcripts found under {slug}/{sessionId}/subagents", async () => {
    const content = JSON.stringify({ type: "user", text: "main transcript" });
    await fsp.writeFile(transcriptPath, content);

    const subDir = path.join(projectsDir, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const subContent = JSON.stringify({
      type: "assistant",
      text: "sub transcript",
    });
    await fsp.writeFile(path.join(subDir, "agent-a1.jsonl"), subContent);

    const session = makeSession(transcriptPath);
    const result = await archiveTranscript(
      db,
      1,
      session,
      backupDir,
      projectsDir,
    );

    expect(result.filesArchived).toBe(2);
    const rows = db
      .prepare("SELECT original_path FROM archives")
      .all() as Array<{
      original_path: string;
    }>;
    const originalPaths = rows.map((row) => row.original_path);
    expect(originalPaths).toContain(transcriptPath);
    expect(originalPaths.some((p) => p.endsWith("agent-a1.jsonl"))).toBe(true);
  });
});
