import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Account,
  ArchiveMeta,
  BackupConfig,
  BackupRun,
  BackupStatusMessage,
  BackupStatusPhase,
  HistoryPeriod,
  HistoryResponse,
  ProjectMapEntry,
} from "../types";

const MAX_RETRY_MS = 15_000;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? `: ${body}` : ""}`);
  }
  return (await response.json()) as T;
}

export interface UseBackupState {
  config: BackupConfig | null;
  runs: BackupRun[];
  history: HistoryResponse | null;
  accounts: Account[];
  projectMap: ProjectMapEntry[];
  backupStatus: BackupStatusPhase;
  lastError: string | null;
  loading: boolean;
  wsConnected: boolean;
  loadAll: (
    period: HistoryPeriod,
    accountFilter?: number | null,
    projectFilter?: string | null,
  ) => Promise<void>;
  getConfig: () => Promise<BackupConfig>;
  putConfig: (patch: Partial<BackupConfig>) => Promise<BackupConfig>;
  runBackup: () => Promise<BackupRun>;
  getRuns: (limit?: number) => Promise<BackupRun[]>;
  getHistory: (
    period: HistoryPeriod,
    accountFilter?: number | null,
    projectFilter?: string | null,
  ) => Promise<HistoryResponse>;
  getAccounts: () => Promise<Account[]>;
  createAccount: (input: {
    label: string;
    email?: string;
    organizationName?: string;
    color: string;
  }) => Promise<Account>;
  deleteAccount: (id: number) => Promise<void>;
  getProjectMap: () => Promise<ProjectMapEntry[]>;
  putProjectMap: (
    projectSlug: string,
    accountId: number | null,
  ) => Promise<void>;
  getArchives: (sessionId: string) => Promise<ArchiveMeta[]>;
}

export function useBackup(): UseBackupState {
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [history, setHistory] = useState<HistoryResponse | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [projectMap, setProjectMap] = useState<ProjectMapEntry[]>([]);
  const [backupStatus, setBackupStatus] = useState<BackupStatusPhase>("idle");
  const [lastError, setLastError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  const currentPeriod = useRef<HistoryPeriod>("today");
  const currentAccount = useRef<number | null>(null);
  const currentProject = useRef<string | null>(null);

  const getConfig = useCallback(async (): Promise<BackupConfig> => {
    const data = await readJson<BackupConfig>(
      await fetch("/api/backup/config"),
    );
    setConfig(data);
    return data;
  }, []);

  const putConfig = useCallback(
    async (patch: Partial<BackupConfig>): Promise<BackupConfig> => {
      const data = await readJson<BackupConfig>(
        await fetch("/api/backup/config", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
      );
      setConfig(data);
      return data;
    },
    [],
  );

  const getRuns = useCallback(async (limit = 20): Promise<BackupRun[]> => {
    const data = await readJson<{ runs: BackupRun[] }>(
      await fetch(`/api/backup/runs?limit=${limit}`),
    );
    setRuns(data.runs);
    return data.runs;
  }, []);

  const getHistory = useCallback(
    async (
      period: HistoryPeriod,
      accountFilter: number | null = null,
      projectFilter: string | null = null,
    ): Promise<HistoryResponse> => {
      currentPeriod.current = period;
      currentAccount.current = accountFilter;
      currentProject.current = projectFilter;
      const params = new URLSearchParams({ period });
      if (accountFilter !== null) params.set("account", String(accountFilter));
      if (projectFilter) params.set("project", projectFilter);
      const data = await readJson<HistoryResponse>(
        await fetch(`/api/backup/history?${params.toString()}`),
      );
      setHistory(data);
      setRuns(data.runs);
      return data;
    },
    [],
  );

  const getAccounts = useCallback(async (): Promise<Account[]> => {
    const data = await readJson<{ accounts: Account[] }>(
      await fetch("/api/accounts"),
    );
    setAccounts(data.accounts);
    return data.accounts;
  }, []);

  const createAccount = useCallback(
    async (input: {
      label: string;
      email?: string;
      organizationName?: string;
      color: string;
    }): Promise<Account> => {
      const data = await readJson<{ account: Account }>(
        await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      setAccounts((previous) => [...previous, data.account]);
      return data.account;
    },
    [],
  );

  const deleteAccount = useCallback(async (id: number): Promise<void> => {
    await readJson<{ ok: true }>(
      await fetch(`/api/accounts/${id}`, { method: "DELETE" }),
    );
    setAccounts((previous) => previous.filter((account) => account.id !== id));
  }, []);

  const getProjectMap = useCallback(async (): Promise<ProjectMapEntry[]> => {
    const data = await readJson<{ entries: ProjectMapEntry[] }>(
      await fetch("/api/project-map"),
    );
    setProjectMap(data.entries);
    return data.entries;
  }, []);

  const putProjectMap = useCallback(
    async (projectSlug: string, accountId: number | null): Promise<void> => {
      await readJson<{ ok: true }>(
        await fetch("/api/project-map", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectSlug, accountId }),
        }),
      );
    },
    [],
  );

  const getArchives = useCallback(
    async (sessionId: string): Promise<ArchiveMeta[]> => {
      const data = await readJson<{ archives: ArchiveMeta[] }>(
        await fetch(`/api/archives?sessionId=${encodeURIComponent(sessionId)}`),
      );
      return data.archives;
    },
    [],
  );

  const refreshAfterRun = useCallback((): void => {
    void getRuns();
    void getHistory(
      currentPeriod.current,
      currentAccount.current,
      currentProject.current,
    );
  }, [getRuns, getHistory]);

  // Polling fallback: after triggering a run, poll getRuns until finishedAt is set.
  const pollUntilFinished = useCallback(
    async (runId: number): Promise<void> => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        try {
          const latest = await getRuns();
          const match = latest.find((run) => run.id === runId);
          if (match && match.finishedAt !== null) {
            setBackupStatus(match.error ? "error" : "done");
            void getHistory(
              currentPeriod.current,
              currentAccount.current,
              currentProject.current,
            );
            return;
          }
        } catch {
          // network hiccup while polling — retry on next tick
        }
      }
    },
    [getRuns, getHistory],
  );

  const runBackup = useCallback(async (): Promise<BackupRun> => {
    setBackupStatus("running");
    setLastError(null);
    try {
      const data = await readJson<{ run: BackupRun }>(
        await fetch("/api/backup/run", { method: "POST" }),
      );
      setRuns((previous) => [data.run, ...previous]);
      if (data.run.finishedAt !== null) {
        setBackupStatus(data.run.error ? "error" : "done");
        refreshAfterRun();
      } else {
        void pollUntilFinished(data.run.id);
      }
      return data.run;
    } catch (error: unknown) {
      setBackupStatus("error");
      setLastError(error instanceof Error ? error.message : "Backup failed");
      throw error;
    }
  }, [pollUntilFinished, refreshAfterRun]);

  const loadAll = useCallback(
    async (
      period: HistoryPeriod,
      accountFilter: number | null = null,
      projectFilter: string | null = null,
    ): Promise<void> => {
      setLoading(true);
      setLastError(null);
      try {
        await Promise.all([
          getConfig(),
          getHistory(period, accountFilter, projectFilter),
          getAccounts(),
          getProjectMap(),
        ]);
      } catch (error: unknown) {
        setLastError(
          error instanceof Error ? error.message : "Failed to load backup data",
        );
      } finally {
        setLoading(false);
      }
    },
    [getConfig, getHistory, getAccounts, getProjectMap],
  );

  // Dedicated WebSocket connection for backup_status push updates.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let disposed = false;
    let retryMs = 1000;

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

    const connect = (): void => {
      if (disposed) return;
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        setWsConnected(true);
        retryMs = 1000;
      };
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data as string) as { type?: string };
          if (message.type !== "backup_status") return;
          const status = message as BackupStatusMessage;
          setBackupStatus(status.status);
          if (status.status === "error" && status.message) {
            setLastError(status.message);
          }
          if (status.status === "done" || status.status === "error") {
            refreshAfterRun();
          }
        } catch {
          // ignore malformed frames
        }
      };
      socket.onclose = () => {
        setWsConnected(false);
        if (!disposed) {
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
        }
      };
      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      disposed = true;
      socket?.close();
    };
  }, [refreshAfterRun]);

  return {
    config,
    runs,
    history,
    accounts,
    projectMap,
    backupStatus,
    lastError,
    loading,
    wsConnected,
    loadAll,
    getConfig,
    putConfig,
    runBackup,
    getRuns,
    getHistory,
    getAccounts,
    createAccount,
    deleteAccount,
    getProjectMap,
    putProjectMap,
    getArchives,
  };
}
