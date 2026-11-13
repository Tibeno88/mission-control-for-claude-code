import { describe, expect, test } from "vitest";
import { parseLine, snippet } from "../src/jsonl.js";

function assistantLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-13T09:44:29.797Z",
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    cwd: "/home/user/projects/demo",
    gitBranch: "main",
    message: {
      id: "msg_01ABC",
      model: "claude-fable-5",
      content: [{ type: "text", text: "Voici la réponse." }],
      usage: {
        input_tokens: 2,
        output_tokens: 1515,
        cache_read_input_tokens: 19704,
        cache_creation_input_tokens: 67292,
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 67292,
        },
      },
    },
    ...overrides,
  });
}

describe("parseLine", () => {
  test("returns null on malformed JSON", () => {
    expect(parseLine("not json at all {")).toBeNull();
  });

  test("returns null when type is missing", () => {
    expect(parseLine('{"foo": 1}')).toBeNull();
  });

  test("parses assistant usage with 5m/1h cache split", () => {
    const entry = parseLine(assistantLine());
    expect(entry).not.toBeNull();
    expect(entry?.model).toBe("claude-fable-5");
    expect(entry?.dedupeKey).toBe("msg_01ABC");
    expect(entry?.usage).toEqual({
      inputTokens: 2,
      outputTokens: 1515,
      cacheReadTokens: 19704,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 67292,
    });
  });

  test("falls back to cache_creation_input_tokens as 5m bucket when split is absent", () => {
    const entry = parseLine(
      assistantLine({
        message: {
          id: "msg_02",
          model: "claude-sonnet-5",
          content: [],
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: 500,
          },
        },
      }),
    );
    expect(entry?.usage?.cacheWrite5mTokens).toBe(500);
    expect(entry?.usage?.cacheWrite1hTokens).toBe(0);
  });

  test("extracts assistant text activity", () => {
    const entry = parseLine(assistantLine());
    expect(entry?.activity).toMatchObject({
      kind: "assistant",
      label: "RESPONSE",
    });
    expect(entry?.activity?.detail).toContain("Voici la réponse.");
  });

  test("extracts tool_use activity with input summary", () => {
    const entry = parseLine(
      assistantLine({
        message: {
          id: "msg_03",
          model: "claude-fable-5",
          content: [
            {
              type: "tool_use",
              name: "Bash",
              input: { command: "ls -la /tmp" },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    expect(entry?.activity).toMatchObject({
      kind: "tool_use",
      label: "Bash",
      detail: "ls -la /tmp",
    });
  });

  test("extracts user prompt with snippet", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-13T10:00:00.000Z",
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        message: { role: "user", content: "Corrige le bug   du parseur" },
      }),
    );
    expect(entry?.activity).toMatchObject({
      kind: "user",
      label: "PROMPT",
      detail: "Corrige le bug du parseur",
    });
  });

  test("extracts slash command name from command tags", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        message: {
          role: "user",
          content: "<command-name>/plan</command-name> rest",
        },
      }),
    );
    expect(entry?.activity).toMatchObject({
      kind: "user",
      label: "COMMAND",
      detail: "/plan",
    });
  });

  test("ignores harness metadata user entries", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        message: {
          role: "user",
          content: "<system-reminder>noise</system-reminder>",
        },
      }),
    );
    expect(entry?.activity).toBeUndefined();
  });

  test("flags tool_result user entries", () => {
    const entry = parseLine(
      JSON.stringify({
        type: "user",
        sessionId: "s1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
        },
      }),
    );
    expect(entry?.activity).toMatchObject({ kind: "tool_result" });
  });

  test("tronque le prompt à 140 caractères par défaut", () => {
    const prompt = "a".repeat(500);
    const detail = parseLine(userPromptLine(prompt))?.activity?.detail;
    expect(detail?.length).toBeLessThanOrEqual(140);
    expect(detail?.endsWith("…")).toBe(true);
  });

  test("garde le prompt intégral en mode full", () => {
    const prompt = "a".repeat(500);
    const detail = parseLine(userPromptLine(prompt), { full: true })?.activity
      ?.detail;
    expect(detail).toBe(prompt);
  });
});

function userPromptLine(text: string): string {
  return JSON.stringify({
    type: "user",
    sessionId: "s1",
    timestamp: "2026-07-13T09:44:29.797Z",
    message: { role: "user", content: text },
  });
}

const ADVISOR_MESSAGE_LINE = JSON.stringify({
  type: "assistant",
  timestamp: "2026-11-13T10:00:00.000Z",
  sessionId: "s1",
  requestId: "req_1",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5-5",
    content: [
      { type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
    ],
    usage: {
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
          model: "claude-opus-5-5",
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
    },
  },
});

describe("advisor iterations", () => {
  test("sums executor iterations and extracts the advisor iteration", () => {
    const entry = parseLine(ADVISOR_MESSAGE_LINE);
    expect(entry?.usage).toEqual({
      inputTokens: 4,
      outputTokens: 300,
      cacheReadTokens: 2000,
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 100,
    });
    expect(entry?.advisor).toEqual([
      {
        model: "claude-opus-5-5",
        usage: {
          inputTokens: 5000,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
        },
      },
    ]);
    expect(entry?.advisorCalls).toBe(1);
  });

  test("leaves a line without iterations parsed as before", () => {
    const entry = parseLine(assistantLine());
    expect(entry?.usage?.outputTokens).toBe(1515);
    expect(entry?.advisor).toBeUndefined();
    expect(entry?.advisorCalls).toBeUndefined();
  });

  test("uses the summed iterations when top-level usage is all zeros", () => {
    const raw = JSON.parse(ADVISOR_MESSAGE_LINE);
    raw.message.usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      iterations: raw.message.usage.iterations,
    };
    const entry = parseLine(JSON.stringify(raw));
    expect(entry?.usage?.outputTokens).toBe(300);
    expect(entry?.usage?.inputTokens).toBe(4);
  });

  test("falls back to the message model when the advisor iteration has none", () => {
    const raw = JSON.parse(ADVISOR_MESSAGE_LINE);
    delete raw.message.usage.iterations[1].model;
    const entry = parseLine(JSON.stringify(raw));
    expect(entry?.advisor?.[0]?.model).toBe("claude-sonnet-5-5");
  });
});

describe("snippet", () => {
  test("collapses whitespace and truncates", () => {
    expect(snippet("a   b\n\nc", 100)).toBe("a b c");
    expect(snippet("x".repeat(300), 10)).toHaveLength(10);
    expect(snippet("x".repeat(300), 10).endsWith("…")).toBe(true);
  });
});

describe("away_summary recap", () => {
  test("extrait le récap sans le suffixe /config", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "away_summary",
      content: "Fix appliqué. (disable recaps in /config)",
      timestamp: "2026-09-09T15:43:55.418Z",
      sessionId: "s1",
    });
    expect(parseLine(line)?.recap).toBe("Fix appliqué.");
  });
});
