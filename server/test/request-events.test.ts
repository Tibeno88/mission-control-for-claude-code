import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../src/backup/db.js";
import { insertRequestEvent } from "../src/backup/request-events.js";
import { PricingTable } from "../src/pricing.js";
import { TranscriptStore, type RequestEvent } from "../src/transcripts.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SLUG = "-home-user-projects-demo";

function line(type: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({ type, sessionId: SESSION_ID, timestamp: new Date().toISOString(), ...extra })}\n`;
}

function assistantUsageLine(
  messageId: string | undefined,
  outputTokens: number,
): string {
  return line("assistant", {
    cwd: "/home/user/projects/demo",
    message: {
      id: messageId,
      model: "claude-fable-5",
      content: [{ type: "text", text: `réponse ${messageId ?? "?"}` }],
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
      },
    },
  });
}

describe("TranscriptStore request-event sink", () => {
  let root: string;
  let store: TranscriptStore;
  let transcript: string;
  let events: RequestEvent[];

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-request-events-"));
    const dir = path.join(root, SLUG);
    await fsp.mkdir(dir, { recursive: true });
    transcript = path.join(dir, `${SESSION_ID}.jsonl`);
    events = [];
    store = new TranscriptStore(
      root,
      new PricingTable(),
      Date.now() - 86_400_000,
      (event) => events.push(event),
    );
  });

  afterEach(async () => {
    await store.stop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("emits one request event per unique message, with resolved rates and pricing source", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_A", 50));
    await store.init();

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.agentId).toBeUndefined();
    expect(event.projectSlug).toBe(SLUG);
    expect(event.model).toBe("claude-fable-5");
    expect(event.usage.inputTokens).toBe(100);
    expect(event.usage.outputTokens).toBe(50);
    // 100*1e-5 + 50*5e-5
    expect(event.costUSD).toBeCloseTo(0.0035, 10);
    expect(event.rateInput).toBe(1e-5);
    expect(event.rateOutput).toBe(5e-5);
    expect(event.pricingSource).toBe("embedded");
    expect(event.dedupeKey).toBe("msg_A");
  });

  test("does not re-emit for a streamed duplicate message id", async () => {
    await fsp.writeFile(
      transcript,
      assistantUsageLine("msg_A", 50) + assistantUsageLine("msg_A", 50),
    );
    await store.init();
    expect(events).toHaveLength(1);
  });

  test("falls back to a synthetic unique dedupe key when the source line has none", async () => {
    await fsp.writeFile(
      transcript,
      assistantUsageLine(undefined, 10) + assistantUsageLine(undefined, 20),
    );
    await store.init();

    expect(events).toHaveLength(2);
    expect(events[0]!.dedupeKey).not.toBe(events[1]!.dedupeKey);
    expect(events[0]!.dedupeKey).toMatch(/^no-dedupe:/);
  });

  test("tags sub-agent request events with their agentId", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_main", 20));
    const subDir = path.join(root, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const agentId = "a1db10a957ad250b3";
    const subLine = `${JSON.stringify({
      type: "assistant",
      sessionId: SESSION_ID,
      agentId,
      attributionAgent: "Explore",
      isSidechain: true,
      timestamp: new Date().toISOString(),
      message: {
        id: "sub_msg_A",
        model: "claude-fable-5",
        content: [{ type: "text", text: "trouvé" }],
        usage: {
          input_tokens: 40,
          output_tokens: 60,
          cache_read_input_tokens: 0,
        },
      },
    })}\n`;
    await fsp.writeFile(path.join(subDir, `agent-${agentId}.jsonl`), subLine);

    await store.init();

    const subEvent = events.find((event) => event.agentId === agentId);
    expect(subEvent).toBeDefined();
    expect(subEvent?.usage.outputTokens).toBe(60);
    expect(subEvent?.sessionId).toBe(SESSION_ID);
  });

  test("re-emits a streamed sub-agent message with its final usage as the last event", async () => {
    const subDir = path.join(root, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const agentId = "a2cc20b68be361c4f";
    const subLine = (outputTokens: number): string =>
      `${JSON.stringify({
        type: "assistant",
        sessionId: SESSION_ID,
        agentId,
        isSidechain: true,
        timestamp: new Date().toISOString(),
        message: {
          id: "sub_msg_stream",
          model: "claude-fable-5",
          content: [{ type: "text", text: "en cours" }],
          usage: {
            input_tokens: 1,
            output_tokens: outputTokens,
            cache_read_input_tokens: 0,
          },
        },
      })}\n`;
    await fsp.writeFile(
      path.join(subDir, `agent-${agentId}.jsonl`),
      subLine(6) + subLine(6) + subLine(3544),
    );

    await store.init();

    const subEvents = events.filter((event) => event.agentId === agentId);
    // First usage (6), then the changed final usage (3544); the identical repeat is silent.
    expect(subEvents).toHaveLength(2);
    const last = subEvents.at(-1)!;
    expect(last.usage.outputTokens).toBe(3544);
    expect(last.usage.inputTokens).toBe(1);
    expect(last.dedupeKey).toBe("sub_msg_stream");
  });
});

describe("insertRequestEvent", () => {
  let root: string;
  let db: Database.Database;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-request-events-db-"));
    db = openDb(path.join(root, "cmc.db"));
  });

  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  function makeEvent(overrides: Partial<RequestEvent> = {}): RequestEvent {
    return {
      sessionId: SESSION_ID,
      projectSlug: SLUG,
      model: "claude-fable-5",
      ts: "2026-08-24T10:00:00.000Z",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
      },
      costUSD: 0.0035,
      rateInput: 1e-5,
      rateOutput: 5e-5,
      pricingSource: "embedded",
      dedupeKey: "msg_A",
      kind: "message",
      ...overrides,
    };
  }

  test("persists a request event with account_id resolved and frozen at write time", () => {
    const { lastInsertRowid: accountId } = db
      .prepare(
        `INSERT INTO accounts (label, email, organization_name, color) VALUES ('Perso', NULL, NULL, '#112233')`,
      )
      .run();
    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)`,
    ).run(SLUG, accountId);

    insertRequestEvent(db, makeEvent());

    const row = db.prepare("SELECT * FROM request_events").get() as {
      session_id: string;
      account_id: number;
      model: string;
      cost_usd: number;
      dedupe_key: string;
    };
    expect(row.session_id).toBe(SESSION_ID);
    expect(row.account_id).toBe(Number(accountId));
    expect(row.model).toBe("claude-fable-5");
    expect(row.cost_usd).toBeCloseTo(0.0035, 10);
    expect(row.dedupe_key).toBe("msg_A");

    // Remapping the project after the fact must not rewrite the historical row.
    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET account_id = excluded.account_id`,
    ).run(SLUG, null);
    const unchanged = db
      .prepare("SELECT account_id FROM request_events")
      .get() as { account_id: number };
    expect(unchanged.account_id).toBe(Number(accountId));
  });

  test("is idempotent on (session_id, agent_id, dedupe_key) — safe to re-ingest from offset 0", () => {
    insertRequestEvent(db, makeEvent());
    insertRequestEvent(db, makeEvent());

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM request_events")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("treats distinct agent_id as a distinct row for the same dedupe_key", () => {
    insertRequestEvent(db, makeEvent({ agentId: undefined }));
    insertRequestEvent(db, makeEvent({ agentId: "agent-1" }));

    const count = db
      .prepare("SELECT COUNT(*) AS n FROM request_events")
      .get() as { n: number };
    expect(count.n).toBe(2);
  });

  test("upserts a re-emitted request: second usage and cost win, account_id and ts stay frozen", () => {
    const { lastInsertRowid: accountId } = db
      .prepare(
        `INSERT INTO accounts (label, email, organization_name, color) VALUES ('Perso', NULL, NULL, '#112233')`,
      )
      .run();
    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)`,
    ).run(SLUG, accountId);

    insertRequestEvent(db, makeEvent());
    db.prepare(
      `INSERT INTO project_account_map (project_slug, account_id) VALUES (?, ?)
       ON CONFLICT(project_slug) DO UPDATE SET account_id = excluded.account_id`,
    ).run(SLUG, null);
    insertRequestEvent(
      db,
      makeEvent({
        ts: "2026-08-24T10:05:00.000Z",
        usage: {
          inputTokens: 100,
          outputTokens: 3544,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        },
        costUSD: 0.1773,
        rateInput: 2e-5,
      }),
    );

    const rows = db.prepare("SELECT * FROM request_events").all() as Array<{
      account_id: number;
      ts: string;
      output_tokens: number;
      cost_usd: number;
      rate_input: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.output_tokens).toBe(3544);
    expect(rows[0]!.cost_usd).toBeCloseTo(0.1773, 10);
    expect(rows[0]!.rate_input).toBe(2e-5);
    expect(rows[0]!.account_id).toBe(Number(accountId));
    expect(rows[0]!.ts).toBe("2026-08-24T10:00:00.000Z");
  });

  test("stores kind 'advisor' for an advisor event and 'message' for a regular one", () => {
    insertRequestEvent(
      db,
      makeEvent({ kind: "advisor", dedupeKey: "msg_A#advisor0" }),
    );
    insertRequestEvent(db, makeEvent({ kind: "message", dedupeKey: "msg_A" }));

    const rows = db
      .prepare(
        "SELECT dedupe_key, kind FROM request_events ORDER BY dedupe_key",
      )
      .all() as Array<{ dedupe_key: string; kind: string }>;
    expect(rows).toEqual([
      { dedupe_key: "msg_A", kind: "message" },
      { dedupe_key: "msg_A#advisor0", kind: "advisor" },
    ]);
  });

  test("upsert rewrites kind on re-emit", () => {
    insertRequestEvent(db, makeEvent({ kind: "message" }));
    insertRequestEvent(db, makeEvent({ kind: "advisor" }));

    const rows = db.prepare("SELECT kind FROM request_events").all() as Array<{
      kind: string;
    }>;
    expect(rows).toEqual([{ kind: "advisor" }]);
  });
});
