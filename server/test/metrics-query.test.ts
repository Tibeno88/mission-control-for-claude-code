import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../src/backup/db.js";
import { queryMetricsPeriods } from "../src/backup/metrics-query.js";

const SLUG = "-home-user-projects-demo";

let dedupeCounter = 0;

function insertEvent(
  db: Database.Database,
  opts: {
    model?: string;
    ts: string;
    inputTokens?: number;
    outputTokens: number;
    costUSD: number;
    projectSlug?: string;
  },
): void {
  dedupeCounter += 1;
  db.prepare(
    `INSERT INTO request_events
       (session_id, agent_id, project_slug, account_id, model, ts,
        input_tokens, output_tokens, cache_read_tokens,
        cache_write_5m_tokens, cache_write_1h_tokens, cost_usd,
        rate_input, rate_output, rate_cache_read, rate_cache_write_5m,
        rate_cache_write_1h, pricing_source, dedupe_key)
     VALUES ('s1', '', ?, NULL, ?, ?, ?, ?, 0, 0, 0, ?, NULL, NULL, NULL, NULL, NULL, 'embedded', ?)`,
  ).run(
    opts.projectSlug ?? SLUG,
    opts.model ?? "claude-fable-5",
    opts.ts,
    opts.inputTokens ?? 100,
    opts.outputTokens,
    opts.costUSD,
    `dedupe-${dedupeCounter}`,
  );
}

function insertRollup(
  db: Database.Database,
  opts: {
    bucket: string;
    model?: string;
    projectSlug?: string | null;
    requests: number;
    outputTokens: number;
    costUSD: number;
  },
): void {
  db.prepare(
    `INSERT INTO request_rollups
       (bucket, model, project_slug, requests, input_tokens, output_tokens,
        cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
        cost_usd, compacted_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, 0, 0, ?, 0)`,
  ).run(
    opts.bucket,
    opts.model ?? "claude-fable-5",
    opts.projectSlug ?? null,
    opts.requests,
    opts.outputTokens,
    opts.costUSD,
  );
}

describe("queryMetricsPeriods", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-metrics-query-"));
    db = openDb(path.join(root, "cmc.db"));
    dedupeCounter = 0;
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("buckets by day and computes exact per-request averages", () => {
    insertEvent(db, {
      ts: "2026-03-10T08:00:00.000Z",
      outputTokens: 100,
      costUSD: 0.01,
    });
    insertEvent(db, {
      ts: "2026-03-10T20:00:00.000Z",
      outputTokens: 300,
      costUSD: 0.03,
    });
    insertEvent(db, {
      ts: "2026-03-11T08:00:00.000Z",
      outputTokens: 50,
      costUSD: 0.02,
    });

    const result = queryMetricsPeriods(db, { bucket: "day" });

    expect(result.points).toHaveLength(2);
    const day1 = result.points.find((p) => p.bucket === "2026-03-10")!;
    expect(day1.requests).toBe(2);
    expect(day1.outputTokens).toBe(400);
    expect(day1.avgOutputTokens).toBe(200);
    expect(day1.avgCostUSD).toBeCloseTo(0.02, 10);

    const day2 = result.points.find((p) => p.bucket === "2026-03-11")!;
    expect(day2.requests).toBe(1);
    expect(day2.avgCostUSD).toBeCloseTo(0.02, 10);
  });

  test("buckets by month across multiple days", () => {
    // Timestamps sit well inside their month (not at a UTC month boundary) so
    // the 'localtime' bucketing stays stable regardless of the runner's timezone.
    insertEvent(db, {
      ts: "2026-03-05T10:00:00.000Z",
      outputTokens: 10,
      costUSD: 0.001,
    });
    insertEvent(db, {
      ts: "2026-03-25T10:00:00.000Z",
      outputTokens: 20,
      costUSD: 0.002,
    });
    insertEvent(db, {
      ts: "2026-04-05T10:00:00.000Z",
      outputTokens: 30,
      costUSD: 0.003,
    });

    const result = queryMetricsPeriods(db, { bucket: "month" });
    const march = result.points.find((p) => p.bucket === "2026-03")!;
    expect(march.requests).toBe(2);
    const april = result.points.find((p) => p.bucket === "2026-04")!;
    expect(april.requests).toBe(1);
  });

  test("buckets by week anchored on Monday", () => {
    // 2026-03-09 is a Monday; 2026-03-11 (Wed) falls in the same ISO week.
    insertEvent(db, {
      ts: "2026-03-09T00:00:00.000Z",
      outputTokens: 10,
      costUSD: 0.001,
    });
    insertEvent(db, {
      ts: "2026-03-11T00:00:00.000Z",
      outputTokens: 10,
      costUSD: 0.001,
    });
    // 2026-03-16 is the following Monday — a separate bucket.
    insertEvent(db, {
      ts: "2026-03-16T00:00:00.000Z",
      outputTokens: 10,
      costUSD: 0.001,
    });

    const result = queryMetricsPeriods(db, { bucket: "week" });
    expect(result.points).toHaveLength(2);
    const firstWeek = result.points.find((p) => p.bucket === "2026-03-09")!;
    expect(firstWeek.requests).toBe(2);
    const secondWeek = result.points.find((p) => p.bucket === "2026-03-16")!;
    expect(secondWeek.requests).toBe(1);
  });

  test("filters by model and project", () => {
    insertEvent(db, {
      ts: "2026-03-10T00:00:00.000Z",
      model: "claude-fable-5",
      projectSlug: SLUG,
      outputTokens: 10,
      costUSD: 0.001,
    });
    insertEvent(db, {
      ts: "2026-03-10T00:00:00.000Z",
      model: "claude-opus-4-5",
      projectSlug: "-other-project",
      outputTokens: 999,
      costUSD: 9,
    });

    const byModel = queryMetricsPeriods(db, {
      bucket: "day",
      model: "claude-fable-5",
    });
    expect(byModel.points).toHaveLength(1);
    expect(byModel.points[0]!.model).toBe("claude-fable-5");

    const byProject = queryMetricsPeriods(db, {
      bucket: "day",
      project: SLUG,
    });
    expect(byProject.points).toHaveLength(1);
    expect(byProject.points[0]!.model).toBe("claude-fable-5");
  });

  test("returns purgedBefore null when no watermark row exists", () => {
    const result = queryMetricsPeriods(db, { bucket: "day" });
    expect(result.purgedBefore).toBeNull();
  });

  test("reports the watermark once set", () => {
    db.prepare(
      `INSERT INTO purge_watermark (id, purged_before, updated_at) VALUES (1, '2026-01-01T00:00:00.000Z', 0)`,
    ).run();
    const result = queryMetricsPeriods(db, { bucket: "day" });
    expect(result.purgedBefore).toBe("2026-01-01T00:00:00.000Z");
  });

  test("folds month-grain rollups into a month-bucket query, merging with live events", () => {
    insertEvent(db, {
      ts: "2026-03-15T00:00:00.000Z",
      outputTokens: 100,
      costUSD: 0.01,
    });
    insertRollup(db, {
      bucket: "2026-03",
      requests: 4,
      outputTokens: 400,
      costUSD: 0.04,
    });

    const result = queryMetricsPeriods(db, { bucket: "month" });
    expect(result.points).toHaveLength(1);
    const march = result.points[0]!;
    // 1 live request + 4 compacted requests
    expect(march.requests).toBe(5);
    expect(march.outputTokens).toBe(500);
    expect(march.costUSD).toBeCloseTo(0.05, 10);
    expect(march.avgOutputTokens).toBe(100);
  });

  test("surfaces a note instead of silently dropping rollups when the grain is finer than month", () => {
    insertRollup(db, {
      bucket: "2026-03",
      requests: 4,
      outputTokens: 400,
      costUSD: 0.04,
    });

    const dayResult = queryMetricsPeriods(db, { bucket: "day" });
    expect(dayResult.points).toHaveLength(0);
    expect(dayResult.note).toBeDefined();
  });
});
