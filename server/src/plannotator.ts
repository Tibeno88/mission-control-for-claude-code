import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { ancestorPids, readProcStat, type StatReader } from "./proc.js";
import type { LiveSession } from "./sessions.js";
import type { PlannotatorSessionInfo } from "./types.js";

const REFRESH_DEBOUNCE_MS = 150;
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Rejects anything that is not a plain http(s) URL: the value is rendered into an
 * <a href> client-side, so `javascript:` and friends must never get through.
 */
function safeUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    return SAFE_PROTOCOLS.has(new URL(raw).protocol) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function parsePlannotatorSession(
  raw: unknown,
): PlannotatorSessionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;

  const pid = record.pid;
  const port = record.port;
  const url = safeUrl(record.url);
  const mode = str(record.mode);
  if (typeof pid !== "number" || !url || !mode) return null;
  if (!pidAlive(pid)) return null;

  const startedAt = Date.parse(String(record.startedAt ?? ""));

  return {
    pid,
    port: typeof port === "number" ? port : 0,
    url,
    mode,
    project: str(record.project) ?? "unknown",
    label: str(record.label),
    startedAt: Number.isNaN(startedAt) ? 0 : startedAt,
  };
}

/**
 * Resolves which Claude session (if any) owns each Plannotator UI.
 *
 * Plannotator is always spawned as a descendant of the Claude Code process (hook or
 * Bash tool), so walking the PPID chain until it hits a live Claude PID gives a
 * *certain* answer. Anything else stays unattached — the project name is far too
 * ambiguous to attribute on (several Claude sessions may share one repo).
 */
export function resolveOwners(
  sessions: readonly PlannotatorSessionInfo[],
  live: readonly LiveSession[],
  read?: StatReader,
): Map<number, string> {
  const owners = new Map<number, string>();
  if (sessions.length === 0 || live.length === 0) return owners;

  const claudeByPid = new Map(live.map((s) => [s.pid, s.sessionId]));

  for (const session of sessions) {
    const own = readProcStat(session.pid, read);
    for (const ancestor of ancestorPids(session.pid, read)) {
      const sessionId = claudeByPid.get(ancestor);
      if (!sessionId) continue;
      // PID reuse guard: a child can never have started before its parent.
      const parent = readProcStat(ancestor, read);
      if (own && parent && own.startTime < parent.startTime) break;
      owners.set(session.pid, sessionId);
      break;
    }
  }

  return owners;
}

/**
 * Mirrors ~/.plannotator/sessions/(pid).json — Plannotator's registry of running UI
 * servers. Same liveness rule as LiveRegistry: a session counts iff its file exists
 * and its PID responds to signal 0.
 */
export class PlannotatorRegistry extends EventEmitter {
  private sessions: PlannotatorSessionInfo[] = [];
  private lastSnapshot = "";
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  /** pid -> owning Claude session id (null = proven unattached). Ancestry never changes. */
  private ownerCache = new Map<number, string | null>();

  constructor(
    private readonly sessionsDir: string,
    private readonly pollMs: number,
    private readonly statReader?: StatReader,
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
    // Plannotator is optional: without this listener an unwatchable directory
    // (never installed, removed, permission denied) surfaces as an unhandled
    // 'error' and takes the whole server down. The poll below still picks the
    // directory up if it appears later.
    this.watcher.on("error", (error) => {
      console.warn(`[plannotator] watch unavailable: ${String(error)}`);
    });
    // Poll as safety net: a killed process leaves a stale file behind.
    this.pollTimer = setInterval(() => void this.refresh(), this.pollMs);
    this.pollTimer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    await this.watcher?.close();
  }

  list(): PlannotatorSessionInfo[] {
    return this.sessions.map((session) => ({ ...session }));
  }

  /** Same list, with `claudeSessionId` set for sessions whose owner is proven. */
  listAttributed(live: readonly LiveSession[]): PlannotatorSessionInfo[] {
    if (this.sessions.length === 0) return [];

    const unresolved = this.sessions.filter(
      (session) => !this.ownerCache.has(session.pid),
    );
    if (unresolved.length > 0) {
      const owners = resolveOwners(unresolved, live, this.statReader);
      for (const session of unresolved) {
        this.ownerCache.set(session.pid, owners.get(session.pid) ?? null);
      }
    }

    return this.sessions.map((session) => {
      const owner = this.ownerCache.get(session.pid);
      return owner ? { ...session, claudeSessionId: owner } : { ...session };
    });
  }

  async refresh(): Promise<void> {
    let names: string[] = [];
    try {
      names = await fsp.readdir(this.sessionsDir);
    } catch {
      names = [];
    }

    const next: PlannotatorSessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const session = await this.readSessionFile(
        path.join(this.sessionsDir, name),
      );
      if (session) next.push(session);
    }
    next.sort((a, b) => b.startedAt - a.startedAt);

    this.sessions = next;
    const alivePids = new Set(next.map((session) => session.pid));
    for (const pid of this.ownerCache.keys()) {
      if (!alivePids.has(pid)) this.ownerCache.delete(pid);
    }

    const snapshot = JSON.stringify(
      next.map((s) => [s.pid, s.url, s.mode, s.startedAt]),
    );
    if (snapshot !== this.lastSnapshot) {
      this.lastSnapshot = snapshot;
      this.emit("change");
    }
  }

  private async readSessionFile(
    file: string,
  ): Promise<PlannotatorSessionInfo | null> {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8")) as unknown;
      return parsePlannotatorSession(raw);
    } catch {
      return null;
    }
  }
}
