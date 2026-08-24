import type Database from "better-sqlite3";
import cron from "node-cron";
import type { Hono } from "hono";
import type { Config } from "../config.js";
import type { TranscriptStore } from "../transcripts.js";
import { getBackupConfig, setBackupConfig } from "./db.js";
import { queryMetricsPeriods, type MetricsBucket } from "./metrics-query.js";
import type { BackupScheduler } from "./scheduler.js";
import type { BackupService } from "./service.js";
import type {
  Account,
  ArchiveMeta,
  BackupConfig,
  HistoryAccountRow,
  HistoryDayPoint,
  HistoryPeriod,
  HistoryProjectRow,
  HistoryResponse,
  HistoryTotals,
  ProjectMapEntry,
} from "./types.js";

const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UNASSIGNED_LABEL = "Non assigné";
const UNASSIGNED_COLOR = "#64748b";
const DEFAULT_HISTORY_RUNS_LIMIT = 20;

export interface BackupRouteDeps {
  db: Database.Database;
  service: BackupService;
  scheduler: BackupScheduler;
  store: TranscriptStore;
  config: Config;
}

interface AccountRow {
  id: number;
  label: string;
  email: string | null;
  organization_name: string | null;
  color: string;
}

interface SnapshotRow {
  session_id: string;
  project_slug: string;
  cwd: string | null;
  account_id: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  last_ts: string | null;
}

interface ArchiveRow {
  session_id: string;
  project_slug: string;
  original_path: string;
  archive_path: string;
  sha256: string;
  bytes_raw: number;
  bytes_gz: number;
  archived_at: number;
}

interface BackupRunRow {
  id: number;
  started_at: number;
  finished_at: number | null;
  mode: "manual" | "scheduled";
  sessions_count: number;
  files_archived: number;
  bytes_raw: number;
  bytes_gz: number;
  error: string | null;
}

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    organizationName: row.organization_name,
    color: row.color,
  };
}

/** Mirrors metrics.ts's projectDisplayName: prefer the cwd's basename. */
function displayName(projectSlug: string, cwd: string | null): string {
  if (cwd) {
    const base = cwd.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  return projectSlug.split("-").filter(Boolean).pop() ?? projectSlug;
}

function clampLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

function periodSinceMs(period: HistoryPeriod): number | undefined {
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (period) {
    case "today": {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      return midnight.getTime();
    }
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "all":
      return undefined;
  }
}

function parsePeriod(raw: string | undefined): HistoryPeriod {
  if (raw === "today" || raw === "7d" || raw === "30d" || raw === "all")
    return raw;
  return "7d";
}

function buildProjectMap(
  db: Database.Database,
  store: TranscriptStore,
): ProjectMapEntry[] {
  const bySlug = new Map<string, { cwd?: string; sessions: Set<string> }>();

  for (const agg of store.sessions()) {
    const entry = bySlug.get(agg.projectSlug) ?? {
      sessions: new Set<string>(),
    };
    entry.sessions.add(agg.sessionId);
    if (agg.cwd) entry.cwd = agg.cwd;
    bySlug.set(agg.projectSlug, entry);
  }

  const snapRows = db
    .prepare(
      "SELECT DISTINCT project_slug, session_id, cwd FROM session_snapshots",
    )
    .all() as Array<{
    project_slug: string;
    session_id: string;
    cwd: string | null;
  }>;
  for (const row of snapRows) {
    const entry = bySlug.get(row.project_slug) ?? {
      sessions: new Set<string>(),
    };
    entry.sessions.add(row.session_id);
    if (!entry.cwd && row.cwd) entry.cwd = row.cwd;
    bySlug.set(row.project_slug, entry);
  }

  const mapRows = db
    .prepare("SELECT project_slug, account_id FROM project_account_map")
    .all() as Array<{ project_slug: string; account_id: number | null }>;
  const accountBySlug = new Map(
    mapRows.map((r) => [r.project_slug, r.account_id]),
  );

  return [...bySlug.entries()].map(([slug, data]) => ({
    projectSlug: slug,
    accountId: accountBySlug.get(slug) ?? null,
    displayName: displayName(slug, data.cwd ?? null),
    sessions: data.sessions.size,
  }));
}

function buildHistory(
  db: Database.Database,
  period: HistoryPeriod,
  accountFilter: number | undefined,
  projectFilter: string | undefined,
): HistoryResponse {
  const sinceMs = periodSinceMs(period);
  const sinceIso =
    sinceMs === undefined ? undefined : new Date(sinceMs).toISOString();

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (sinceIso !== undefined) {
    conditions.push("last_ts >= ?");
    params.push(sinceIso);
  }
  if (accountFilter !== undefined) {
    conditions.push("account_id = ?");
    params.push(accountFilter);
  }
  if (projectFilter !== undefined) {
    conditions.push("project_slug = ?");
    params.push(projectFilter);
  }
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Latest snapshot per session_id within the filtered set (dedupes repeated
  // backups of the same session across multiple runs).
  const rows = db
    .prepare(
      `SELECT * FROM session_snapshots
       WHERE id IN (
         SELECT MAX(id) FROM session_snapshots ${whereClause} GROUP BY session_id
       )`,
    )
    .all(...params) as SnapshotRow[];

  const totals: HistoryTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    sessions: rows.length,
  };
  const accountAgg = new Map<
    number | null,
    { sessions: number; tokens: number; costUSD: number }
  >();
  const projectAgg = new Map<
    string,
    {
      cwd: string | null;
      accountId: number | null;
      sessions: number;
      tokens: number;
      costUSD: number;
    }
  >();
  const dayAgg = new Map<string, { costUSD: number; tokens: number }>();

  for (const row of rows) {
    const tokens = row.input_tokens + row.output_tokens;
    totals.inputTokens += row.input_tokens;
    totals.outputTokens += row.output_tokens;
    totals.cacheReadTokens += row.cache_read_tokens;
    totals.cacheWriteTokens += row.cache_write_tokens;
    totals.costUSD += row.cost_usd;

    const accEntry = accountAgg.get(row.account_id) ?? {
      sessions: 0,
      tokens: 0,
      costUSD: 0,
    };
    accEntry.sessions += 1;
    accEntry.tokens += tokens;
    accEntry.costUSD += row.cost_usd;
    accountAgg.set(row.account_id, accEntry);

    const projEntry = projectAgg.get(row.project_slug) ?? {
      cwd: row.cwd,
      accountId: row.account_id,
      sessions: 0,
      tokens: 0,
      costUSD: 0,
    };
    projEntry.sessions += 1;
    projEntry.tokens += tokens;
    projEntry.costUSD += row.cost_usd;
    if (row.cwd) projEntry.cwd = row.cwd;
    projectAgg.set(row.project_slug, projEntry);

    if (row.last_ts && row.last_ts.length >= 10) {
      const day = row.last_ts.slice(0, 10);
      const dayEntry = dayAgg.get(day) ?? { costUSD: 0, tokens: 0 };
      dayEntry.costUSD += row.cost_usd;
      dayEntry.tokens += tokens;
      dayAgg.set(day, dayEntry);
    }
  }

  const accountRows = db
    .prepare("SELECT * FROM accounts")
    .all() as AccountRow[];
  const accountsById = new Map(
    accountRows.map((row) => [row.id, rowToAccount(row)]),
  );

  const byAccount: HistoryAccountRow[] = [...accountAgg.entries()]
    .map(([accountId, agg]) => {
      const account =
        accountId === null ? undefined : accountsById.get(accountId);
      return {
        accountId,
        label: account?.label ?? UNASSIGNED_LABEL,
        color: account?.color ?? UNASSIGNED_COLOR,
        sessions: agg.sessions,
        tokens: agg.tokens,
        costUSD: agg.costUSD,
      };
    })
    .sort((a, b) => b.costUSD - a.costUSD);

  const byProject: HistoryProjectRow[] = [...projectAgg.entries()]
    .map(([projectSlug, agg]) => ({
      projectSlug,
      displayName: displayName(projectSlug, agg.cwd),
      accountId: agg.accountId,
      sessions: agg.sessions,
      tokens: agg.tokens,
      costUSD: agg.costUSD,
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const timeline: HistoryDayPoint[] = [...dayAgg.entries()]
    .map(([day, agg]) => ({ day, costUSD: agg.costUSD, tokens: agg.tokens }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const runConditions: string[] = [];
  const runParams: unknown[] = [];
  if (sinceMs !== undefined) {
    runConditions.push("started_at >= ?");
    runParams.push(sinceMs);
  }
  const runWhere =
    runConditions.length > 0 ? `WHERE ${runConditions.join(" AND ")}` : "";
  const runRows = db
    .prepare(
      `SELECT * FROM backup_runs ${runWhere} ORDER BY started_at DESC LIMIT ${DEFAULT_HISTORY_RUNS_LIMIT}`,
    )
    .all(...runParams) as BackupRunRow[];
  const runs = runRows.map((row) => ({
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    mode: row.mode,
    sessionsCount: row.sessions_count,
    filesArchived: row.files_archived,
    bytesRaw: row.bytes_raw,
    bytesGz: row.bytes_gz,
    error: row.error,
  }));

  return { period, totals, byAccount, byProject, timeline, runs };
}

export function registerBackupRoutes(app: Hono, deps: BackupRouteDeps): void {
  const { db, service, scheduler, store, config } = deps;

  app.post("/api/backup/run", async (c) => {
    try {
      const run = await service.run("manual");
      return c.json({ run });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, 409);
    }
  });

  app.get("/api/backup/runs", (c) => {
    const limit = clampLimit(c.req.query("limit"), 50, 200);
    return c.json({ runs: service.listRuns(limit) });
  });

  app.get("/api/metrics/periods", (c) => {
    const bucketRaw = c.req.query("bucket");
    if (bucketRaw !== "day" && bucketRaw !== "week" && bucketRaw !== "month") {
      return c.json({ error: "bucket must be day, week or month" }, 400);
    }
    const bucket: MetricsBucket = bucketRaw;
    return c.json(
      queryMetricsPeriods(db, {
        bucket,
        from: c.req.query("from") || undefined,
        to: c.req.query("to") || undefined,
        model: c.req.query("model") || undefined,
        project: c.req.query("project") || undefined,
      }),
    );
  });

  app.get("/api/backup/history", (c) => {
    const period = parsePeriod(c.req.query("period"));
    const accountRaw = c.req.query("account");
    const accountFilter =
      accountRaw === undefined || accountRaw === ""
        ? undefined
        : Number.parseInt(accountRaw, 10);
    if (accountFilter !== undefined && Number.isNaN(accountFilter)) {
      return c.json({ error: "invalid account" }, 400);
    }
    const projectFilter = c.req.query("project") || undefined;
    return c.json(buildHistory(db, period, accountFilter, projectFilter));
  });

  app.get("/api/backup/config", (c) => {
    return c.json(getBackupConfig(db, config.backupDir));
  });

  app.put("/api/backup/config", async (c) => {
    let body: Partial<BackupConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (body.cron !== undefined && !cron.validate(body.cron)) {
      return c.json({ error: "invalid cron expression" }, 400);
    }
    if (
      body.retentionDays !== undefined &&
      (!Number.isInteger(body.retentionDays) || body.retentionDays < 0)
    ) {
      return c.json(
        { error: "retentionDays must be a non-negative integer" },
        400,
      );
    }
    if (body.backupDir !== undefined && typeof body.backupDir !== "string") {
      return c.json({ error: "backupDir must be a string" }, 400);
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return c.json({ error: "enabled must be a boolean" }, 400);
    }

    setBackupConfig(db, body);
    scheduler.reload();
    return c.json(getBackupConfig(db, config.backupDir));
  });

  app.get("/api/accounts", (c) => {
    const rows = db
      .prepare("SELECT * FROM accounts ORDER BY id")
      .all() as AccountRow[];
    return c.json({ accounts: rows.map(rowToAccount) });
  });

  app.post("/api/accounts", async (c) => {
    let body: {
      label?: unknown;
      email?: unknown;
      organizationName?: unknown;
      color?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.label !== "string" || body.label.trim() === "") {
      return c.json({ error: "label is required" }, 400);
    }
    if (typeof body.color !== "string" || !COLOR_RE.test(body.color)) {
      return c.json({ error: "color must match #RRGGBB" }, 400);
    }
    const email = typeof body.email === "string" ? body.email : null;
    const organizationName =
      typeof body.organizationName === "string" ? body.organizationName : null;

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO accounts (label, email, organization_name, color) VALUES (?, ?, ?, ?)`,
      )
      .run(body.label, email, organizationName, body.color);

    const account: Account = {
      id: Number(lastInsertRowid),
      label: body.label,
      email,
      organizationName,
      color: body.color,
    };
    return c.json({ account });
  });

  app.delete("/api/accounts/:id", (c) => {
    const idRaw = c.req.param("id");
    const id = Number.parseInt(idRaw, 10);
    if (!Number.isInteger(id) || String(id) !== idRaw) {
      return c.json({ error: "invalid account id" }, 400);
    }
    db.transaction(() => {
      db.prepare(
        "UPDATE project_account_map SET account_id = NULL WHERE account_id = ?",
      ).run(id);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    })();
    return c.json({ ok: true });
  });

  app.get("/api/project-map", (c) => {
    return c.json({ entries: buildProjectMap(db, store) });
  });

  app.put("/api/project-map", async (c) => {
    let body: { projectSlug?: unknown; accountId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (
      typeof body.projectSlug !== "string" ||
      body.projectSlug.trim() === ""
    ) {
      return c.json({ error: "projectSlug is required" }, 400);
    }
    if (body.accountId !== null && !Number.isInteger(body.accountId)) {
      return c.json({ error: "accountId must be an integer or null" }, 400);
    }
    if (body.accountId !== null) {
      const exists = db
        .prepare("SELECT id FROM accounts WHERE id = ?")
        .get(body.accountId as number);
      if (!exists) return c.json({ error: "accountId does not exist" }, 400);
    }

    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET account_id = excluded.account_id`,
    ).run(body.projectSlug, body.accountId as number | null);
    return c.json({ ok: true });
  });

  app.get("/api/archives", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
      return c.json({ error: "invalid session id" }, 400);
    }
    const rows = db
      .prepare(
        "SELECT * FROM archives WHERE session_id = ? ORDER BY archived_at DESC",
      )
      .all(sessionId) as ArchiveRow[];
    const archives: ArchiveMeta[] = rows.map((row) => ({
      sessionId: row.session_id,
      projectSlug: row.project_slug,
      originalPath: row.original_path,
      archivePath: row.archive_path,
      sha256: row.sha256,
      bytesRaw: row.bytes_raw,
      bytesGz: row.bytes_gz,
      archivedAt: row.archived_at,
    }));
    return c.json({ archives });
  });
}
