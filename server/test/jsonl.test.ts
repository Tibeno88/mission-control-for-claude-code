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
});

describe("snippet", () => {
  test("collapses whitespace and truncates", () => {
    expect(snippet("a   b\n\nc", 100)).toBe("a b c");
    expect(snippet("x".repeat(300), 10)).toHaveLength(10);
    expect(snippet("x".repeat(300), 10).endsWith("…")).toBe(true);
  });
});
