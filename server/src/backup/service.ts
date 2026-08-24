import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { PricingTable } from "../pricing.js";
import type { SessionAgg, TranscriptStore } from "../transcripts.js";
import { archiveTranscript } from "./archive.js";
import { getBackupConfig, resolveAccountId } from "./db.js";
import { applyRetention } from "./retention.js";
import type { BackupMode, BackupRun } from "./types.js";

interface BackupRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  mode: BackupMode;
  sessions_count: number;
  files_archived: number;
  bytes_raw: number;
  bytes_gz: number;
  error: string | null;
}

function rowToRun(row: BackupRunRow): BackupRun {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mode: row.mode,
    sessionsCount: row.sessions_count,
    filesArchived: row.files_archived,
    bytesRaw: row.bytes_raw,
    bytesGz: row.bytes_gz,
    error: row.error,
  };
}

function insertSnapshot(
  db: Database.Database,
  runId: number,
  session: SessionAgg,
  accountId: number | null,
  pricing: PricingTable,
): void {
  const cacheWriteTokens =
    session.usage.cacheWrite5mTokens + session.usage.cacheWrite1hTokens;
  // A session's rate_* columns and pricing_source only make sense when it used
  // a single model — a multi-model session has no single $/token rate to
  // store without fabricating a blended figure. request_events (Phase 1)
  // carries the exact per-request rate regardless of model mix; this snapshot
  // stays a best-effort convenience on top of it.
  const models = [...session.models];
  const singleModel = models.length === 1 ? models[0] : undefined;
  const rates = singleModel ? pricing.resolve(singleModel) : undefined;
  const pricingSource = singleModel
    ? pricing.pricingSource(singleModel)
    : models.length > 1
      ? "mixed"
      : null;

  db.prepare(
    `INSERT INTO session_snapshots
       (run_id, session_id, project_slug, cwd, git_branch, account_id, models,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens,
        cost_usd, prompts, sub_agent_cost_usd, first_ts, last_ts,
        rate_input, rate_output, rate_cache_read, rate_cache_write_5m,
        rate_cache_write_1h, pricing_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    session.sessionId,
    session.projectSlug,
    session.cwd ?? null,
    session.gitBranch ?? null,
    accountId,
    JSON.stringify(models),
    session.usage.inputTokens,
    session.usage.outputTokens,
    session.usage.cacheReadTokens,
    cacheWriteTokens,
    session.usage.cacheWrite5mTokens,
    session.usage.cacheWrite1hTokens,
    session.costUSD,
    session.prompts,
    session.subAgentCostUSD,
    session.firstTs ?? null,
    session.lastTs ?? null,
    rates?.input ?? null,
    rates?.output ?? null,
    rates?.cacheRead ?? null,
    rates?.cacheWrite5m ?? null,
    rates?.cacheWrite1h ?? null,
    pricingSource,
  );
}

/**
 * Orchestrates one backup pass: snapshots every known session's aggregates
 * into `session_snapshots`, archives (gzip + dedup) raw transcripts, and
 * applies retention. Emits "status" events for WS broadcast. Only one run
 * may be in flight at a time (subsequent calls are rejected, not queued).
 */
export class BackupService extends EventEmitter {
  private runningPromise: Promise<BackupRun> | undefined;

  constructor(
    private readonly db: Database.Database,
    private readonly store: TranscriptStore,
    private readonly config: Config,
    private readonly pricing: PricingTable = new PricingTable(),
  ) {
    super();
  }

  isRunning(): boolean {
    return this.runningPromise !== undefined;
  }

  async run(mode: BackupMode): Promise<BackupRun> {
    if (this.runningPromise) {
      throw new Error("a backup run is already in progress");
    }
    const promise = this.executeRun(mode).finally(() => {
      this.runningPromise = undefined;
    });
    this.runningPromise = promise;
    return promise;
  }

  private async executeRun(mode: BackupMode): Promise<BackupRun> {
    this.emit("status", { status: "running" });
    const startedAt = Date.now();
    const insertRun = this.db.prepare(
      `INSERT INTO backup_runs (started_at, mode, sessions_count, files_archived, bytes_raw, bytes_gz)
       VALUES (?, ?, 0, 0, 0, 0)`,
    );
    const { lastInsertRowid } = insertRun.run(startedAt, mode);
    const runId = Number(lastInsertRowid);

    try {
      const backupConfig = getBackupConfig(this.db, this.config.backupDir);
      let sessionsCount = 0;
      let filesArchived = 0;
      let bytesRaw = 0;
      let bytesGz = 0;

      for (const session of this.store.sessions()) {
        const accountId = resolveAccountId(this.db, session.projectSlug);
        insertSnapshot(this.db, runId, session, accountId, this.pricing);
        sessionsCount += 1;

        const archived = await archiveTranscript(
          this.db,
          runId,
          session,
          backupConfig.backupDir,
          this.config.projectsDir,
        );
        filesArchived += archived.filesArchived;
        bytesRaw += archived.bytesRaw;
        bytesGz += archived.bytesGz;
      }

      await applyRetention(
        this.db,
        backupConfig.backupDir,
        backupConfig.retentionDays,
      );

      const finishedAt = Date.now();
      this.db
        .prepare(
          `UPDATE backup_runs
             SET finished_at = ?, sessions_count = ?, files_archived = ?, bytes_raw = ?, bytes_gz = ?
           WHERE id = ?`,
        )
        .run(
          finishedAt,
          sessionsCount,
          filesArchived,
          bytesRaw,
          bytesGz,
          runId,
        );

      const run: BackupRun = {
        id: runId,
        startedAt,
        finishedAt,
        mode,
        sessionsCount,
        filesArchived,
        bytesRaw,
        bytesGz,
        error: null,
      };
      this.emit("status", { status: "done", run });
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const finishedAt = Date.now();
      this.db
        .prepare(
          `UPDATE backup_runs SET finished_at = ?, error = ? WHERE id = ?`,
        )
        .run(finishedAt, message, runId);
      this.emit("status", { status: "error", message });
      throw error;
    }
  }

  /** Reads persisted backup_runs rows, most recent first. */
  listRuns(limit: number): BackupRun[] {
    const rows = this.db
      .prepare("SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as BackupRunRow[];
    return rows.map(rowToRun);
  }
}
