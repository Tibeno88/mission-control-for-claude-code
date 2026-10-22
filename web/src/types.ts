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

/**
 * A live Plannotator UI server. `claudeSessionId` is only present when the owning
 * Claude session was resolved with certainty (PID ancestry), never guessed.
 */
export interface PlannotatorSessionInfo {
  pid: number;
  port: number;
  url: string;
  mode: string;
  project: string;
  label?: string;
  /** Epoch ms. */
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
  headless?: boolean;
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
  subAgents: SubAgentSummary[];
  subAgentCostUSD: number;
  /** Plannotator UIs proven to belong to this session. */
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

export interface Snapshot {
  type: "snapshot";
  fleet: FleetSession[];
  metrics: GlobalMetrics;
  /** Every live Plannotator UI — attached and unattached alike. */
  plannotator: PlannotatorSessionInfo[];
  tasks: Task[];
  generatedAt: number;
}

// ===== Kanban tasks (headless `claude -p` runs) =====

export type TaskStatus = "todo" | "in_progress" | "waiting" | "done" | "archived";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  status: TaskStatus;
  sessionId: string | null;
  lastResult: string | null;
  error: string | null;
  costUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

// ===== Backup / archive supervision (Phase 5) =====

export type BackupMode = "manual" | "scheduled";

export interface BackupRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  mode: BackupMode;
  sessionsCount: number;
  filesArchived: number;
  bytesRaw: number;
  bytesGz: number;
  error: string | null;
}

export interface Account {
  id: number;
  label: string;
  email: string | null;
  organizationName: string | null;
  color: string;
}

export interface ProjectMapEntry {
  projectSlug: string;
  accountId: number | null;
  displayName: string;
  sessions: number;
}

export interface BackupConfig {
  enabled: boolean;
  cron: string;
  retentionDays: number;
  backupDir: string;
}

export interface ArchiveMeta {
  sessionId: string;
  projectSlug: string;
  originalPath: string;
  archivePath: string;
  sha256: string;
  bytesRaw: number;
  bytesGz: number;
  archivedAt: number;
}

export interface HistoryTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  sessions: number;
}

export interface HistoryAccountRow {
  accountId: number | null;
  label: string;
  color: string;
  sessions: number;
  tokens: number;
  costUSD: number;
}

export interface HistoryProjectRow {
  projectSlug: string;
  displayName: string;
  accountId: number | null;
  sessions: number;
  tokens: number;
  costUSD: number;
}

export interface HistoryDayPoint {
  day: string;
  costUSD: number;
  tokens: number;
}

export type HistoryPeriod = "today" | "7d" | "30d" | "all";

export interface HistoryResponse {
  period: HistoryPeriod;
  totals: HistoryTotals;
  byAccount: HistoryAccountRow[];
  byProject: HistoryProjectRow[];
  timeline: HistoryDayPoint[];
  runs: BackupRun[];
}

export type MetricsBucket = "day" | "week" | "month";

export interface MetricsPeriodPoint {
  bucket: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
  avgCostUSD: number;
  avgOutputTokens: number;
}

export interface MetricsPeriodsResponse {
  bucket: MetricsBucket;
  points: MetricsPeriodPoint[];
  purgedBefore: string | null;
  note?: string;
}

export type BackupStatusPhase = "idle" | "running" | "done" | "error";

export interface BackupStatusMessage {
  type: "backup_status";
  status: "running" | "done" | "error";
  run?: BackupRun;
  message?: string;
  generatedAt: number;
}
