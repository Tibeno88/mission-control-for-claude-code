export type SessionStatus = "busy" | "waiting" | "idle" | "ended" | "missing";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  };
}

export function addUsage(target: UsageTotals, delta: UsageTotals): UsageTotals {
  return {
    inputTokens: target.inputTokens + delta.inputTokens,
    outputTokens: target.outputTokens + delta.outputTokens,
    cacheReadTokens: target.cacheReadTokens + delta.cacheReadTokens,
    cacheWrite5mTokens: target.cacheWrite5mTokens + delta.cacheWrite5mTokens,
    cacheWrite1hTokens: target.cacheWrite1hTokens + delta.cacheWrite1hTokens,
  };
}

export type ActivityKind =
  "user" | "assistant" | "tool_use" | "tool_result" | "system";

export interface ActivityEvent {
  ts: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
}

/** Aggregated summary of one sub-agent (Task/Agent) spawned within a session. */
export interface SubAgentSummary {
  agentId: string;
  /** Attributed agent type, e.g. "Explore", "code-reviewer". */
  type?: string;
  models: string[];
  usage: UsageTotals;
  costUSD: number;
  firstTs?: string;
  lastTs?: string;
  /** Snippet of the task prompt handed to the sub-agent. */
  taskPrompt?: string;
}

/**
 * One live Plannotator UI server, mirrored from ~/.plannotator/sessions/(pid).json.
 * `claudeSessionId` is only set when the owning Claude session was resolved with
 * certainty (PID ancestry) — never guessed from the project name.
 */
export interface PlannotatorSessionInfo {
  pid: number;
  port: number;
  url: string;
  mode: string;
  project: string;
  label?: string;
  /** Epoch ms, normalised from Plannotator's ISO 8601 `startedAt`. */
  startedAt: number;
  claudeSessionId?: string;
}

/** Claude's end-of-turn recap sentence. */
export interface SessionRecap {
  ts: string;
  text: string;
}

export interface FleetSession {
  sessionId: string;
  /** Session title from the live registry — absent once the session ended. */
  name?: string;
  /** "derived" when Claude Code auto-generated `name`; absent when chosen. */
  nameSource?: string;
  kind?: string;
  agent?: string;
  status: SessionStatus;
  waitingFor?: string;
  pid?: number;
  cwd?: string;
  projectSlug?: string;
  gitBranch?: string;
  models: string[];
  startedAt?: number;
  statusUpdatedAt?: number;
  lastEventTs?: string;
  lastActivity?: ActivityEvent;
  /** Latest recap, dropped once a newer prompt starts. */
  recap?: SessionRecap;
  prompts: number;
  usage: UsageTotals;
  costUSD: number;
  /** Per-sub-agent breakdown (usage/cost already included in `usage`/`costUSD`). */
  subAgents: SubAgentSummary[];
  /** Portion of `costUSD` attributable to sub-agents. */
  subAgentCostUSD: number;
  /** Plannotator UIs proven to belong to this session (empty/absent otherwise). */
  plannotator?: PlannotatorSessionInfo[];
}

export interface HourPoint {
  hour: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
}

export interface PeriodStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  sessions: number;
}

export interface GlobalMetrics {
  today: PeriodStats;
  last7d: PeriodStats;
  byProject: Array<{
    project: string;
    sessions: number;
    tokens: number;
    costUSD: number;
  }>;
  byModel: Array<{
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUSD: number;
  }>;
  timeline24h: HourPoint[];
}
