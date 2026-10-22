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

  test("tronque les détails par défaut et les garde intégraux en mode full", async () => {
    const prompt = "b".repeat(500);
    await fsp.writeFile(
      transcript,
      line("user", { message: { role: "user", content: prompt } }),
    );
    await store.init();
    const short = await store.recentActivity(SESSION_ID);
    const full = await store.recentActivity(SESSION_ID, 80, { full: true });
    expect(short[0]?.detail?.length).toBeLessThanOrEqual(140);
    expect(full[0]?.detail).toBe(prompt);
  });

  test("mode full lit tout le transcript au-delà de la fenêtre de fin et ignore limit", async () => {
    const prompt = "c".repeat(500);
    const noise = line("system", {
      subtype: "noise",
      content: "z".repeat(300),
    });
    await fsp.writeFile(
      transcript,
      line("user", { message: { role: "user", content: prompt } }) +
        noise.repeat(1000) +
        assistantUsageLine("msg_G", 3),
    );
    await store.init();
    const tail = await store.recentActivity(SESSION_ID, 80);
    const full = await store.recentActivity(SESSION_ID, 1, { full: true });
    expect(tail.some((e) => e.label === "PROMPT")).toBe(false);
    expect(full.find((e) => e.label === "PROMPT")?.detail).toBe(prompt);
    expect(full.length).toBeGreaterThan(1);
  });

  test("feeds hourly buckets used by period metrics", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_F", 1000));
    await store.init();
    const currentHour = new Date().toISOString().slice(0, 13);
    const bucket = store.hourly().get(currentHour);
    expect(bucket?.outputTokens).toBe(1000);
    expect(bucket?.costUSD).toBeGreaterThan(0);
  });

  test("aggregates sub-agent transcripts and folds their cost into the session", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_main", 20));

    const subDir = path.join(root, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const agentId = "a1db10a957ad250b3";
    const subLines =
      `${JSON.stringify({
        type: "user",
        sessionId: SESSION_ID,
        agentId,
        attributionAgent: "Explore",
        isSidechain: true,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "explore le dossier server" },
      })}\n` +
      `${JSON.stringify({
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
    await fsp.writeFile(path.join(subDir, `agent-${agentId}.jsonl`), subLines);

    await store.init();

    const agg = store.sessions()[0]!;
    expect(agg.subAgents.size).toBe(1);
    const sub = agg.subAgents.get(agentId)!;
    expect(sub.type).toBe("Explore");
    expect(sub.taskPrompt).toBe("explore le dossier server");
    expect(sub.usage.outputTokens).toBe(60);
    expect(sub.models.has("claude-fable-5")).toBe(true);

    // Sub-agent usage is folded into the parent totals.
    expect(agg.usage.outputTokens).toBe(80); // 20 main + 60 sub
    expect(agg.subAgentCostUSD).toBeGreaterThan(0);
    expect(agg.costUSD).toBeGreaterThan(agg.subAgentCostUSD);
  });

  test("flags sessions as missing on unlink and revives them on re-ingest", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_G", 3));
    await store.init();
    expect(store.sessions()[0]?.missing).toBe(false);

    await fsp.rm(transcript);
    store.handleUnlink(transcript);
    expect(store.sessions()[0]?.missing).toBe(true);

    await fsp.writeFile(transcript, assistantUsageLine("msg_H", 4));
    await store.ingest(transcript);
    expect(store.sessions()[0]?.missing).toBe(false);
    expect(store.sessions()[0]?.usage.outputTokens).toBe(7);
  });
});
