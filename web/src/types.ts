export type SessionStatus = "busy" | "waiting" | "idle" | "ended" | "missing";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export type ActivityKind =
  "user" | "assistant" | "tool_use" | "tool_result" | "system";

export interface ActivityEvent {
  ts: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
}

export interface SubAgentSummary {
  agentId: string;
  type?: string;
  models: string[];
  usage: UsageTotals;
  costUSD: number;
  firstTs?: string;
  lastTs?: string;
  taskPrompt?: string;
}

export interface FleetSession {
  sessionId: string;
  name?: string;
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
  prompts: number;
  usage: UsageTotals;
  costUSD: number;
  subAgents: SubAgentSummary[];
  subAgentCostUSD: number;
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

export interface Snapshot {
  type: "snapshot";
  fleet: FleetSession[];
  metrics: GlobalMetrics;
  generatedAt: number;
}
