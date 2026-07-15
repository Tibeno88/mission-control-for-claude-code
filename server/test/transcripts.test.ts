import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PricingTable } from "../src/pricing.js";
import { TranscriptStore } from "../src/transcripts.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SLUG = "-home-user-projects-demo";

function line(type: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({ type, sessionId: SESSION_ID, timestamp: new Date().toISOString(), ...extra })}\n`;
}

function assistantUsageLine(messageId: string, outputTokens: number): string {
  return line("assistant", {
    cwd: "/home/user/projects/demo",
    gitBranch: "main",
    message: {
      id: messageId,
      model: "claude-fable-5",
      content: [{ type: "text", text: `réponse ${messageId}` }],
      usage: {
        input_tokens: 100,
        output_tokens: outputTokens,
        cache_read_input_tokens: 0,
      },
    },
  });
}

describe("TranscriptStore", () => {
  let root: string;
  let store: TranscriptStore;
  let transcript: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-test-"));
    const dir = path.join(root, SLUG);
    await fsp.mkdir(dir, { recursive: true });
    transcript = path.join(dir, `${SESSION_ID}.jsonl`);
    store = new TranscriptStore(
      root,
      new PricingTable(),
      Date.now() - 86_400_000,
    );
  });

  afterEach(async () => {
    await store.stop();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("aggregates usage, dedupes duplicated message ids, counts prompts", async () => {
    await fsp.writeFile(
      transcript,
      line("user", { message: { role: "user", content: "fais le café" } }) +
        assistantUsageLine("msg_A", 50) +
        assistantUsageLine("msg_A", 50) + // streamed duplicate: must count once
        assistantUsageLine("msg_B", 25),
    );
    await store.init();

    const sessions = store.sessions();
    expect(sessions).toHaveLength(1);
    const agg = sessions[0]!;
    expect(agg.sessionId).toBe(SESSION_ID);
    expect(agg.prompts).toBe(1);
    expect(agg.usage.inputTokens).toBe(200); // msg_A once + msg_B
    expect(agg.usage.outputTokens).toBe(75);
    expect(agg.models.has("claude-fable-5")).toBe(true);
    // 200*1e-5 + 75*5e-5
    expect(agg.costUSD).toBeCloseTo(0.00575, 10);
    expect(agg.lastActivity?.label).toBe("RESPONSE");
  });

  test("tails appended lines incrementally without recounting", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_A", 10));
    await store.init();
    expect(store.sessions()[0]?.usage.outputTokens).toBe(10);

    await fsp.appendFile(transcript, assistantUsageLine("msg_C", 30));
    await store.ingest(transcript);
    const agg = store.sessions()[0]!;
    expect(agg.usage.outputTokens).toBe(40);
    expect(agg.usage.inputTokens).toBe(200);
  });

  test("handles partial trailing lines across ingests", async () => {
    const full = assistantUsageLine("msg_D", 5);
    const cut = 40;
    await fsp.writeFile(transcript, full.slice(0, cut));
    await store.init();
    expect(store.sessions()).toHaveLength(0);

    await fsp.appendFile(transcript, full.slice(cut));
    await store.ingest(transcript);
    expect(store.sessions()[0]?.usage.outputTokens).toBe(5);
  });

  test("exposes recent activity from the transcript tail", async () => {
    await fsp.writeFile(
      transcript,
      line("user", {
        message: { role: "user", content: "analyse ce fichier" },
      }) + assistantUsageLine("msg_E", 7),
    );
    await store.init();
    const events = await store.recentActivity(SESSION_ID);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]).toMatchObject({ kind: "user", label: "PROMPT" });
  });

  test("feeds hourly buckets used by period metrics", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_F", 1000));
    await store.init();
    const currentHour = new Date().toISOString().slice(0, 13);
    const bucket = store.hourly().get(currentHour);
    expect(bucket?.outputTokens).toBe(1000);
    expect(bucket?.costUSD).toBeGreaterThan(0);
  });
});
