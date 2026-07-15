import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

export type LiveStatus = "busy" | "waiting" | "idle";

export interface LiveSession {
  pid: number;
  sessionId: string;
  status: LiveStatus;
  waitingFor?: string;
  cwd?: string;
  kind?: string;
  name?: string;
  agent?: string;
  version?: string;
  startedAt?: number;
  updatedAt?: number;
  statusUpdatedAt?: number;
}

const LIVE_STATUSES: ReadonlySet<string> = new Set(["busy", "waiting", "idle"]);
const REFRESH_DEBOUNCE_MS = 150;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors ~/.claude/sessions/(pid).json — the live registry Claude Code
 * maintains for running sessions. A session is live iff its file exists
 * and its PID responds to signal 0.
 */
export class LiveRegistry extends EventEmitter {
  private sessions = new Map<string, LiveSession>();
  private lastSnapshot = "";
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly sessionsDir: string,
    private readonly pollMs: number,
  ) {
    super();
  }

  async start(): Promise<void> {
    await this.refresh();
    this.watcher = chokidar.watch(this.sessionsDir, {
      ignoreInitial: true,
      depth: 0,
    });
    const schedule = (): void => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(
        () => void this.refresh(),
        REFRESH_DEBOUNCE_MS,
      );
    };
    this.watcher.on("add", schedule);
    this.watcher.on("change", schedule);
    this.watcher.on("unlink", schedule);
    // Poll as safety net: a killed process leaves a stale file behind.
    this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    await this.watcher?.close();
  }

  list(): LiveSession[] {
    return [...this.sessions.values()];
  }

  async refresh(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.sessionsDir);
    } catch {
      names = [];
    }

    const next = new Map<string, LiveSession>();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const session = await this.readSessionFile(
        path.join(this.sessionsDir, name),
      );
      if (!session) continue;
      const existing = next.get(session.sessionId);
      if (!existing || (session.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
        next.set(session.sessionId, session);
      }
    }

    this.sessions = next;
    const snapshot = JSON.stringify(
      [...next.keys()].sort().map((id) => {
        const s = next.get(id);
        return [id, s?.status, s?.waitingFor, s?.updatedAt];
      }),
    );
    if (snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      this.emit("change");
    }
  }

  private async readSessionFile(file: string): Promise<LiveSession | null> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const record = raw as Record<string, unknown>;
    const pid = record.pid;
    const sessionId = record.sessionId;
    if (
      typeof pid !== "number" ||
      typeof sessionId !== "string" ||
      !pidAlive(pid)
    )
      return null;

    const status =
      typeof record.status === "string" && LIVE_STATUSES.has(record.status)
        ? (record.status as LiveStatus)
        : "idle";

    return {
      pid,
      sessionId,
      status,
      waitingFor:
        typeof record.waitingFor === "string" ? record.waitingFor : undefined,
      cwd: typeof record.cwd === "string" ? record.cwd : undefined,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      name: typeof record.name === "string" ? record.name : undefined,
      agent: typeof record.agent === "string" ? record.agent : undefined,
      version: typeof record.version === "string" ? record.version : undefined,
      startedAt:
        typeof record.startedAt === "number" ? record.startedAt : undefined,
      updatedAt:
        typeof record.updatedAt === "number" ? record.updatedAt : undefined,
      statusUpdatedAt:
        typeof record.statusUpdatedAt === "number"
          ? record.statusUpdatedAt
          : undefined,
    };
  }
}
