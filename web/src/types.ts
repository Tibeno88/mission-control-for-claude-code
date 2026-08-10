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

export type BackupStatusPhase = "idle" | "running" | "done" | "error";

export interface BackupStatusMessage {
  type: "backup_status";
  status: "running" | "done" | "error";
  run?: BackupRun;
  message?: string;
  generatedAt: number;
}
