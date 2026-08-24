import type Database from "better-sqlite3";

export type MetricsBucket = "day" | "week" | "month";

export interface MetricsPeriodPoint {
  bucket: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  avgCostUSD: number;
  avgOutputTokens: number;
}

export interface MetricsPeriodsQuery {
  bucket: MetricsBucket;
  from?: string;
  to?: string;
  model?: string;
  project?: string;
}

export interface MetricsPeriodsResponse {
  bucket: MetricsBucket;
  points: MetricsPeriodPoint[];
  purgedBefore: string | null;
  note?: string;
}

/**
 * SQL bucket expression for a timestamp column, in local time (matches the
 * existing "today" boundary in backup/api.ts's periodSinceMs). Week is
 * Monday-anchored by real calendar date rather than an ISO week number, which
 * sidesteps the week-number/year mismatch at year boundaries.
 */
function bucketExpr(bucket: MetricsBucket, column: string): string {
  switch (bucket) {
    case "day":
      return `date(${column}, 'localtime')`;
    case "week":
      return `date(${column}, 'localtime', '-' || ((CAST(strftime('%w', ${column}, 'localtime') AS INTEGER) + 6) % 7) || ' days')`;
    case "month":
      return `strftime('%Y-%m', ${column}, 'localtime')`;
  }
}

interface WatermarkRow {
  purged_before: string;
}

function getPurgedBefore(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT purged_before FROM purge_watermark WHERE id = 1")
    .get() as WatermarkRow | undefined;
  return row?.purged_before ?? null;
}

interface RawPointRow {
  bucket: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
}

interface MergedTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
}

function mergeRows(rows: RawPointRow[]): MetricsPeriodPoint[] {
  const merged = new Map<
    string,
    { bucket: string; model: string } & MergedTotals
  >();
  for (const row of rows) {
    const key = `${row.bucket}::${row.model}`;
    const entry = merged.get(key) ?? {
      bucket: row.bucket,
      model: row.model,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUSD: 0,
    };
    entry.requests += row.requests;
    entry.inputTokens += row.input_tokens;
    entry.outputTokens += row.output_tokens;
    entry.cacheReadTokens += row.cache_read_tokens;
    entry.cacheWriteTokens += row.cache_write_tokens;
    entry.costUSD += row.cost_usd;
    merged.set(key, entry);
  }
  return [...merged.values()]
    .map((entry) => ({
      ...entry,
      avgCostUSD: entry.requests > 0 ? entry.costUSD / entry.requests : 0,
      avgOutputTokens:
        entry.requests > 0 ? entry.outputTokens / entry.requests : 0,
    }))
    .sort(
      (a, b) =>
        a.bucket.localeCompare(b.bucket) || a.model.localeCompare(b.model),
    );
}

/**
 * Buckets request_events by day/week/month x model, folding in compacted
 * request_rollups when the requested grain is month (rollups only ever carry
 * month-grain buckets — Phase 1's compaction design). requests stays the
 * denominator throughout, so avgCostUSD/avgOutputTokens stay exact across a
 * purge instead of drifting once raw rows are gone.
 */
export function queryMetricsPeriods(
  db: Database.Database,
  query: MetricsPeriodsQuery,
): MetricsPeriodsResponse {
  const { bucket, from, to, model, project } = query;

  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from !== undefined) {
    conditions.push("ts >= ?");
    params.push(from);
  }
  if (to !== undefined) {
    conditions.push("ts <= ?");
    params.push(to);
  }
  if (model !== undefined) {
    conditions.push("model = ?");
    params.push(model);
  }
  if (project !== undefined) {
    conditions.push("project_slug = ?");
    params.push(project);
  }
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const eventRows = db
    .prepare(
      `SELECT ${bucketExpr(bucket, "ts")} AS bucket, model,
              COUNT(*) AS requests,
              SUM(input_tokens) AS input_tokens,
              SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens,
              SUM(cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
              SUM(cost_usd) AS cost_usd
       FROM request_events
       ${whereClause}
       GROUP BY bucket, model`,
    )
    .all(...params) as RawPointRow[];

  const rollupConditions: string[] = [];
  const rollupParams: unknown[] = [];
  if (model !== undefined) {
    rollupConditions.push("model = ?");
    rollupParams.push(model);
  }
  if (project !== undefined) {
    rollupConditions.push("(project_slug = ? OR project_slug IS NULL)");
    rollupParams.push(project);
  }
  if (from !== undefined) {
    rollupConditions.push("bucket >= ?");
    rollupParams.push(from.slice(0, 7));
  }
  if (to !== undefined) {
    rollupConditions.push("bucket <= ?");
    rollupParams.push(to.slice(0, 7));
  }
  const rollupWhere =
    rollupConditions.length > 0
      ? `WHERE ${rollupConditions.join(" AND ")}`
      : "";
  const rollupRows = db
    .prepare(
      `SELECT bucket, model, requests,
              input_tokens, output_tokens, cache_read_tokens,
              (cache_write_5m_tokens + cache_write_1h_tokens) AS cache_write_tokens,
              cost_usd
       FROM request_rollups
       ${rollupWhere}`,
    )
    .all(...rollupParams) as RawPointRow[];

  let note: string | undefined;
  let combined = eventRows;
  if (rollupRows.length > 0) {
    if (bucket === "month") {
      combined = [...eventRows, ...rollupRows];
    } else {
      note =
        "Des périodes compactées par la purge existent et ne sont disponibles qu'au grain mois — non incluses dans ce regroupement plus fin.";
    }
  }

  return {
    bucket,
    points: mergeRows(combined),
    purgedBefore: getPurgedBefore(db),
    note,
  };
}
