import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { PricingTable } from "../src/pricing.js";
import { TranscriptStore, type RequestEvent } from "../src/transcripts.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const SLUG = "-home-user-projects-demo";

const EXECUTOR_MODEL = "claude-sonnet-5-5";
const ADVISOR_MODEL = "claude-opus-5-5";
const pricing = new PricingTable();
// Executor = top-level fields minus the advisor iteration, summed over iterations.
const EXECUTOR_USAGE = {
  inputTokens: 4,
  outputTokens: 300,
  cacheReadTokens: 2000,
  cacheWrite5mTokens: 50,
  cacheWrite1hTokens: 100,
};
const ADVISOR_USAGE = {
  inputTokens: 5000,
  outputTokens: 400,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};
/** Final usage of an advisor-bearing message, as every line of that message carries it. */
const ADVISOR_MESSAGE_USAGE = {
  input_tokens: 4,
  output_tokens: 300,
  cache_read_input_tokens: 2000,
  cache_creation_input_tokens: 150,
  cache_creation: {
    ephemeral_5m_input_tokens: 0,
    ephemeral_1h_input_tokens: 100,
  },
  iterations: [
    {
      type: "message",
      input_tokens: 2,
      output_tokens: 100,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 100,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 100,
      },
    },
    {
      type: "advisor_message",
      model: ADVISOR_MODEL,
      input_tokens: 5000,
      output_tokens: 400,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
    },
    {
      type: "message",
      input_tokens: 2,
      output_tokens: 200,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
      cache_creation: {
        ephemeral_5m_input_tokens: 50,
        ephemeral_1h_input_tokens: 0,
      },
    },
  ],
};
const ADVISOR_BLOCK = {
  type: "server_tool_use",
  id: "srvtoolu_1",
  name: "advisor",
  input: {},
};
const ADVISOR_RESULT_BLOCK = {
  type: "advisor_tool_result",
  tool_use_id: "srvtoolu_1",
  content: "conseil",
};

function line(type: string, extra: Record<string, unknown>): string {
  return `${JSON.stringify({ type, sessionId: SESSION_ID, timestamp: new Date().toISOString(), ...extra })}\n`;
}

/** One streamed line of an assistant message: real transcripts repeat message.id per content block. */
function messageLine(
  messageId: string,
  content: unknown[],
  usage: unknown,
  extra: Record<string, unknown> = {},
): string {
  return line("assistant", {
    ...extra,
    message: { id: messageId, model: EXECUTOR_MODEL, content, usage },
  });
}

/** Sum of the last event per request, as request_events upserts them (a superseded line is replaced). */
function latestCostPerRequest(events: RequestEvent[]): number {
  const latest = new Map<string, number>();
  for (const event of events)
    latest.set(`${event.agentId ?? ""}|${event.dedupeKey}`, event.costUSD);
  return [...latest.values()].reduce((sum, cost) => sum + cost, 0);
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

  test("keeps only the last streamed usage of a sub-agent message (last line wins)", async () => {
    await fsp.writeFile(transcript, assistantUsageLine("msg_main", 20));

    const subDir = path.join(root, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const agentId = "a2cc20b68be361c4f";
    const subLine = (outputTokens: number): string =>
      `${JSON.stringify({
        type: "assistant",
        sessionId: SESSION_ID,
        agentId,
        attributionAgent: "Explore",
        isSidechain: true,
        timestamp: new Date().toISOString(),
        message: {
          id: "sub_msg_partial",
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

    const agg = store.sessions()[0]!;
    const sub = agg.subAgents.get(agentId)!;
    expect(sub.usage.outputTokens).toBe(3544);
    expect(sub.usage.inputTokens).toBe(1);
    expect(agg.usage.outputTokens).toBe(3564); // 20 main + 3544 final sub
    expect(agg.usage.inputTokens).toBe(101);
    // Cost of the final sub usage only (fable: 1e-5 input, 5e-5 output).
    expect(sub.costUSD).toBeCloseTo(1e-5 + 3544 * 5e-5, 10);
    expect(agg.subAgentCostUSD).toBeCloseTo(sub.costUSD, 10);
    expect(agg.costUSD).toBeCloseTo(20 * 5e-5 + 100 * 1e-5 + sub.costUSD, 10);

    // Retraction must reach the global buckets too, not only the session.
    const model = store.byModel().get("claude-fable-5")!;
    expect(model.outputTokens).toBe(3564);
    expect(model.costUSD).toBeCloseTo(agg.costUSD, 10);
    const hours = [...store.hourly().values()];
    expect(hours.reduce((sum, h) => sum + h.outputTokens, 0)).toBe(3564);
    expect(hours.reduce((sum, h) => sum + h.costUSD, 0)).toBeCloseTo(
      agg.costUSD,
      10,
    );
  });

  test("prices advisor iterations at the advisor model rates, apart from the executor", async () => {
    const events: RequestEvent[] = [];
    store = new TranscriptStore(
      root,
      pricing,
      Date.now() - 86_400_000,
      (event) => events.push(event),
    );
    await fsp.writeFile(
      transcript,
      messageLine(
        "msg_adv",
        [{ type: "thinking", thinking: "réflexion" }],
        ADVISOR_MESSAGE_USAGE,
      ) +
        messageLine("msg_adv", [ADVISOR_BLOCK], ADVISOR_MESSAGE_USAGE) +
        messageLine("msg_adv", [ADVISOR_RESULT_BLOCK], ADVISOR_MESSAGE_USAGE) +
        messageLine(
          "msg_adv",
          [{ type: "text", text: "fini" }],
          ADVISOR_MESSAGE_USAGE,
        ),
    );
    await store.init();

    const agg = store.sessions()[0]!;
    const executorCost = pricing.costUSD(EXECUTOR_MODEL, EXECUTOR_USAGE);
    const advisorCost = pricing.costUSD(ADVISOR_MODEL, ADVISOR_USAGE);
    expect(agg.costUSD).toBeCloseTo(executorCost + advisorCost, 10);
    expect(agg.advisorCalls).toBe(1);
    expect(agg.advisorCostUSD).toBeCloseTo(advisorCost, 10);
    expect(agg.usage.outputTokens).toBe(700); // 300 executor + 400 advisor
    expect([...agg.models].sort()).toEqual(
      [ADVISOR_MODEL, EXECUTOR_MODEL].sort(),
    );

    expect(events.map((event) => event.kind).sort()).toEqual([
      "advisor",
      "message",
    ]);
    expect(events.find((event) => event.kind === "advisor")).toMatchObject({
      model: ADVISOR_MODEL,
      dedupeKey: "msg_adv#advisor0",
    });
    expect(latestCostPerRequest(events)).toBeCloseTo(agg.costUSD, 10);
  });

  test("counts sub-agent advisor cost once the final streamed line lands", async () => {
    const events: RequestEvent[] = [];
    store = new TranscriptStore(
      root,
      pricing,
      Date.now() - 86_400_000,
      (event) => events.push(event),
    );
    await fsp.writeFile(transcript, assistantUsageLine("msg_main", 20));

    const subDir = path.join(root, SLUG, SESSION_ID, "subagents");
    await fsp.mkdir(subDir, { recursive: true });
    const agentId = "a3f0adv1c0de00001";
    const subFields = {
      agentId,
      attributionAgent: "Explore",
      isSidechain: true,
    };
    const partialUsage = {
      input_tokens: 1,
      output_tokens: 6,
      cache_read_input_tokens: 0,
    };
    await fsp.writeFile(
      path.join(subDir, `agent-${agentId}.jsonl`),
      messageLine(
        "sub_adv",
        [{ type: "text", text: "en cours" }],
        partialUsage,
        subFields,
      ) +
        messageLine("sub_adv", [ADVISOR_BLOCK], partialUsage, subFields) +
        messageLine(
          "sub_adv",
          [{ type: "text", text: "fini" }],
          ADVISOR_MESSAGE_USAGE,
          subFields,
        ),
    );
    await store.init();

    const agg = store.sessions()[0]!;
    const sub = agg.subAgents.get(agentId)!;
    const executorCost = pricing.costUSD(EXECUTOR_MODEL, EXECUTOR_USAGE);
    const advisorCost = pricing.costUSD(ADVISOR_MODEL, ADVISOR_USAGE);
    const mainCost = pricing.costUSD("claude-fable-5", {
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
    });
    expect(sub.models.has(ADVISOR_MODEL)).toBe(true);
    expect(sub.costUSD).toBeCloseTo(executorCost + advisorCost, 10);
    expect(agg.subAgentCostUSD).toBeCloseTo(sub.costUSD, 10);
    expect(agg.advisorCalls).toBe(1);
    expect(agg.advisorCostUSD).toBeCloseTo(advisorCost, 10);
    expect(agg.costUSD).toBeCloseTo(mainCost + sub.costUSD, 10);

    const advisorEvents = events.filter((event) => event.kind === "advisor");
    expect(advisorEvents).toHaveLength(1);
    expect(advisorEvents[0]?.costUSD).toBeCloseTo(advisorCost, 10);
    expect(latestCostPerRequest(events)).toBeCloseTo(agg.costUSD, 10);
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
