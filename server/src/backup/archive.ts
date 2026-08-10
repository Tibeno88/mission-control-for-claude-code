import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import type Database from "better-sqlite3";
import type { SessionAgg } from "../transcripts.js";

export interface ArchiveResult {
  filesArchived: number;
  bytesRaw: number;
  bytesGz: number;
}

interface ArchiveRow {
  sha256: string;
}

/** Locates sub-agent transcripts under `{slug}/{sessionId}/subagents/agent-*.jsonl`. */
async function findSubAgentFiles(
  projectsDir: string,
  projectSlug: string,
  sessionId: string,
): Promise<string[]> {
  const subDir = path.join(projectsDir, projectSlug, sessionId, "subagents");
  try {
    const names = await fsp.readdir(subDir);
    return names
      .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
      .map((name) => path.join(subDir, name));
  } catch {
    return [];
  }
}

function sha256Of(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function alreadyArchived(db: Database.Database, sha256: string): boolean {
  const row = db
    .prepare("SELECT sha256 FROM archives WHERE sha256 = ?")
    .get(sha256) as ArchiveRow | undefined;
  return row !== undefined;
}

/** Gzips one transcript file into `backupDir/{slug}/{basename}.gz` and records it. */
async function archiveOneFile(
  db: Database.Database,
  runId: number,
  sessionId: string,
  projectSlug: string,
  filePath: string,
  backupDir: string,
): Promise<{ bytesRaw: number; bytesGz: number } | null> {
  let raw: Buffer;
  try {
    raw = await fsp.readFile(filePath);
  } catch {
    return null; // file disappeared on disk — skip, don't fail the run
  }

  const sha256 = sha256Of(raw);
  if (alreadyArchived(db, sha256)) return null; // dedup

  const destDir = path.join(backupDir, projectSlug);
  await fsp.mkdir(destDir, { recursive: true });
  const archivePath = path.join(destDir, `${path.basename(filePath)}.gz`);
  const gz = zlib.gzipSync(raw);
  await fsp.writeFile(archivePath, gz);

  db.prepare(
    `INSERT INTO archives
       (run_id, session_id, project_slug, original_path, archive_path, sha256, bytes_raw, bytes_gz, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    sessionId,
    projectSlug,
    filePath,
    archivePath,
    sha256,
    raw.byteLength,
    gz.byteLength,
    Date.now(),
  );

  return { bytesRaw: raw.byteLength, bytesGz: gz.byteLength };
}

/**
 * Archives the main transcript and any sub-agent transcripts for one session.
 * Deduplicates by sha256 (already-archived content is skipped). Tolerates
 * missing files — a session with a vanished transcript still yields 0 files.
 */
export async function archiveTranscript(
  db: Database.Database,
  runId: number,
  session: SessionAgg,
  backupDir: string,
  projectsDir: string,
): Promise<ArchiveResult> {
  const result: ArchiveResult = { filesArchived: 0, bytesRaw: 0, bytesGz: 0 };

  const subAgentFiles = await findSubAgentFiles(
    projectsDir,
    session.projectSlug,
    session.sessionId,
  );
  const candidates = [session.transcriptPath, ...subAgentFiles];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    const archived = await archiveOneFile(
      db,
      runId,
      session.sessionId,
      session.projectSlug,
      filePath,
      backupDir,
    );
    if (!archived) continue;
    result.filesArchived += 1;
    result.bytesRaw += archived.bytesRaw;
    result.bytesGz += archived.bytesGz;
  }

  return result;
}
