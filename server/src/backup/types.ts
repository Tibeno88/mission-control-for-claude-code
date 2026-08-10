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

export interface BackupStatusEvent {
  status: "running" | "done" | "error";
  run?: BackupRun;
  message?: string;
}
