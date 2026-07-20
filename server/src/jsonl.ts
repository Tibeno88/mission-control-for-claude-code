import type { ActivityEvent, UsageTotals } from "./types.js";

export interface ParsedEntry {
  type: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  isSidechain: boolean;
  /** Present on sub-agent transcript lines (~/.claude/…/{session}/subagents/). */
  agentId?: string;
  /** Sub-agent type as attributed by Claude Code (e.g. "Explore", "code-reviewer"). */
  attributionAgent?: string;
  model?: string;
  usage?: UsageTotals;
  dedupeKey?: string;
  activity?: ActivityEvent;
}

const SNIPPET_MAX = 140;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function snippet(text: string, max = SNIPPET_MAX): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

const TOOL_INPUT_KEYS = [
  "command",
  "file_path",
  "pattern",
  "path",
  "url",
  "query",
  "description",
  "prompt",
  "skill",
] as const;

function summarizeToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of TOOL_INPUT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return snippet(value, 100);
  }
  return undefined;
}

function parseUsage(rawUsage: unknown): UsageTotals | undefined {
  if (!rawUsage || typeof rawUsage !== "object") return undefined;
  const usage = rawUsage as Record<string, unknown>;
  const cacheCreation = (usage.cache_creation ?? {}) as Record<string, unknown>;
  const hasSplit =
    "ephemeral_5m_input_tokens" in cacheCreation ||
    "ephemeral_1h_input_tokens" in cacheCreation;
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5mTokens: hasSplit
      ? num(cacheCreation.ephemeral_5m_input_tokens)
      : num(usage.cache_creation_input_tokens),
    cacheWrite1hTokens: num(cacheCreation.ephemeral_1h_input_tokens),
  };
}

function assistantActivity(
  raw: Record<string, unknown>,
  ts: string,
): ActivityEvent | undefined {
  const message = raw.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as Record<string, unknown>;
    if (typed.type === "tool_use" && typeof typed.name === "string") {
      return {
        ts,
        kind: "tool_use",
        label: typed.name,
        detail: summarizeToolInput(typed.input),
      };
    }
    if (
      typed.type === "text" &&
      typeof typed.text === "string" &&
      typed.text.trim()
    ) {
      return {
        ts,
        kind: "assistant",
        label: "RESPONSE",
        detail: snippet(typed.text),
      };
    }
  }
  return undefined;
}

function userActivity(
  raw: Record<string, unknown>,
  ts: string,
): ActivityEvent | undefined {
  if (raw.isMeta === true) return undefined;
  const message = raw.message as Record<string, unknown> | undefined;
  const content = message?.content;

  let text: string | undefined;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === "tool_result") {
        return { ts, kind: "tool_result", label: "TOOL RESULT" };
      }
      if (typed.type === "text" && typeof typed.text === "string") {
        text = typed.text;
        break;
      }
    }
  }
  if (!text || !text.trim()) return undefined;

  const command = text.match(/^<command-name>([^<]+)<\/command-name>/);
  if (command?.[1]) {
    return { ts, kind: "user", label: "COMMAND", detail: snippet(command[1]) };
  }
  // Angle-bracket-only content is harness metadata (reminders, attachments), not a prompt.
  if (text.trimStart().startsWith("<")) return undefined;
  return { ts, kind: "user", label: "PROMPT", detail: snippet(text) };
}

export function parseLine(line: string): ParsedEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type !== "string") return null;

  const ts = str(record.timestamp) ?? "";
  const entry: ParsedEntry = {
    type: record.type,
    timestamp: str(record.timestamp),
    sessionId: str(record.sessionId),
    cwd: str(record.cwd),
    gitBranch: str(record.gitBranch),
    isSidechain: record.isSidechain === true,
    agentId: str(record.agentId),
    attributionAgent: str(record.attributionAgent),
  };

  if (record.type === "assistant") {
    const message = record.message as Record<string, unknown> | undefined;
    entry.model = str(message?.model);
    entry.usage = parseUsage(message?.usage);
    if (entry.usage) {
      entry.dedupeKey =
        str(message?.id) ?? str(record.requestId) ?? str(record.uuid);
    }
    entry.activity = assistantActivity(record, ts);
  } else if (record.type === "user") {
    entry.activity = userActivity(record, ts);
  } else if (record.type === "summary" && typeof record.summary === "string") {
    entry.activity = {
      ts,
      kind: "system",
      label: "SUMMARY",
      detail: snippet(record.summary),
    };
  }

  return entry;
}
