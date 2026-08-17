import fs from "node:fs";

/** Minimal view of /proc/<pid>/stat: who spawned the process, and when. */
export interface ProcStat {
  ppid: number;
  /** Field 22 of /proc/<pid>/stat — clock ticks since boot. Comparable across PIDs. */
  startTime: number;
}

/** Reads a raw /proc/<pid>/stat line. Injectable so tests never touch the real /proc. */
export type StatReader = (pid: number) => string | null;

const DEFAULT_MAX_DEPTH = 12;

export const readStatFile: StatReader = (pid) => {
  try {
    return fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
};

/**
 * Parses /proc/<pid>/stat. The `comm` field (2nd) is parenthesised and may itself
 * contain spaces and parentheses, so everything up to the LAST ")" is skipped
 * rather than naively splitting the whole line on whitespace.
 */
export function parseProcStat(raw: string): ProcStat | null {
  const close = raw.lastIndexOf(")");
  if (close === -1) return null;
  // After "pid (comm)" the remaining fields start at #3 (state).
  const rest = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number.parseInt(rest[1] ?? "", 10);
  const startTime = Number.parseInt(rest[19] ?? "", 10);
  if (Number.isNaN(ppid) || Number.isNaN(startTime)) return null;
  return { ppid, startTime };
}

export function readProcStat(
  pid: number,
  read: StatReader = readStatFile,
): ProcStat | null {
  const raw = read(pid);
  return raw ? parseProcStat(raw) : null;
}

/**
 * Walks the parent chain of `pid`, nearest ancestor first. Returns [] when /proc
 * is unreadable (non-Linux hosts) — callers then simply get no attribution.
 */
export function ancestorPids(
  pid: number,
  read: StatReader = readStatFile,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = pid;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    const stat = readProcStat(current, read);
    if (!stat) break;
    const { ppid } = stat;
    if (ppid <= 1 || seen.has(ppid)) break;
    seen.add(ppid);
    chain.push(ppid);
    current = ppid;
  }

  return chain;
}
