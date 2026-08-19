import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { parseLine } from "./jsonl.js";
import type { PricingTable } from "./pricing.js";
import {
  addUsage,
  emptyUsage,
  type ActivityEvent,
  type UsageTotals,
} from "./types.js";

/** Running aggregate for one sub-agent transcript within a session. */
export interface SubAgentAgg {
  agentId: string;
  type?: string;
  models: Set<string>;
  usage: UsageTotals;
  costUSD: number;
  firstTs?: string;
  lastTs?: string;
  taskPrompt?: string;
}

export interface SessionAgg {
  sessionId: string;
  projectSlug: string;
  transcriptPath: string;
  cwd?: string;
  gitBranch?: string;
  models: Set<string>;
  firstTs?: string;
  lastTs?: string;
  prompts: number;
  usage: UsageTotals;
  costUSD: number;
  lastActivity?: ActivityEvent;
  /** Sub-agents (Task/Agent) spawned in this session, keyed by agentId. */
  subAgents: Map<string, SubAgentAgg>;
  /** Portion of `costUSD` contributed by sub-agents. */
  subAgentCostUSD: number;
  /** Transcript file no longer exists on disk (aggregates kept in memory). */
  missing: boolean;
}

export interface HourStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUSD: number;
}

export interface ModelStats {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
}

interface FileState {
  offset: number;
  remainder: string;
  projectSlug: string;
  /** Parent session id when this file is a sub-agent transcript. */
  subAgentOf?: string;
  /** Sub-agent id (derived from the file name) for sub-agent transcripts. */
  agentId?: string;
}

const ACTIVITY_TAIL_BYTES = 256 * 1024;
const HOUR_PRUNE_THRESHOLD = 500;
const HOUR_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Watches ~/.claude/projects/(slug)/(session).jsonl transcripts, tails them
 * incrementally (per-file byte offset) and maintains per-session usage
 * aggregates plus global hourly/model buckets.
 */
export class TranscriptStore extends EventEmitter {
  private readonly files = new Map<string, FileState>();
  private readonly sessionAggs = new Map<string, SessionAgg>();
  private readonly seenUsageKeys = new Map<string, Set<string>>();
  private readonly hourBuckets = new Map<string, HourStats>();
  private readonly modelBuckets = new Map<string, ModelStats>();
  private readonly ingestChains = new Map<string, Promise<void>>();
  private watcher?: FSWatcher;

  constructor(
    private readonly projectsDir: string,
    private readonly pricing: PricingTable,
    private readonly cutoffMs: number,
  ) {
    super();
  }

  async init(): Promise<void> {
    let slugs: string[] = [];
    try {
      const dirents = await fsp.readdir(this.projectsDir, {
        withFileTypes: true,
      });
      slugs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch (error) {
      console.warn(
        `[transcripts] cannot read ${this.projectsDir}:`,
        (error as Error).message,
      );
    }

    for (const slug of slugs) {
      const dir = path.join(this.projectsDir, slug);
      let names: string[] = [];
      try {
        names = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(dir, name);
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs < this.cutoffMs) continue;
        } catch {
          continue;
        }
        await this.ingest(file);
      }
    }

    // Second pass (parents already ingested): sub-agent transcripts live at
    // {slug}/{sessionId}/subagents/agent-*.jsonl.
    for (const slug of slugs) {
      await this.scanSubAgentDir(path.join(this.projectsDir, slug));
    }

    // depth 3 reaches {slug}/{sessionId}/subagents/agent-*.jsonl.
    this.watcher = chokidar.watch(this.projectsDir, {
      ignoreInitial: true,
      depth: 3,
    });
    const onFile = (file: string): void => {
      if (file.endsWith(".jsonl")) void this.ingest(file);
    };
    this.watcher.on("add", onFile);
    this.watcher.on("change", onFile);
    this.watcher.on("unlink", (file: string) => {
      if (file.endsWith(".jsonl")) this.handleUnlink(file);
    });
    // A missing ~/.claude/projects must not crash the server: without this
    // listener the watch error would go unhandled.
    this.watcher.on("error", (error) => {
      console.warn(`[transcripts] watch unavailable: ${String(error)}`);
    });
  }

  /** Ingests every recent sub-agent transcript under a project slug directory. */
  private async scanSubAgentDir(slugDir: string): Promise<void> {
    let sessionDirs: string[] = [];
    try {
      const dirents = await fsp.readdir(slugDir, { withFileTypes: true });
      sessionDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return;
    }
    for (const sessionId of sessionDirs) {
      const subDir = path.join(slugDir, sessionId, "subagents");
      let names: string[] = [];
      try {
        names = await fsp.readdir(subDir);
      } catch {
        continue; // no subagents/ for this session
      }
      for (const name of names) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(subDir, name);
        try {
          const stat = await fsp.stat(file);
          if (stat.mtimeMs < this.cutoffMs) continue;
        } catch {
          continue;
        }
        await this.ingest(file);
      }
    }
  }

  /** Transcript deleted on disk: flag its sessions as missing, keep the data. */
  handleUnlink(file: string): void {
    this.files.delete(file);
    let changed = false;
    for (const agg of this.sessionAggs.values()) {
      if (agg.transcriptPath === file && !agg.missing) {
        agg.missing = true;
        changed = true;
      }
    }
    if (changed) this.emit("update");
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  /** Serialized per-file ingestion (watcher events can overlap). */
  ingest(file: string): Promise<void> {
    const previous = this.ingestChains.get(file) ?? Promise.resolve();
    const next = previous
      .then(() => this.readNewBytes(file))
      .catch((error) =>
        console.warn(`[transcripts] ingest ${file}:`, (error as Error).message),
      )
      .finally(() => {
        if (this.ingestChains.get(file) === next)
          this.ingestChains.delete(file);
      });
    this.ingestChains.set(file, next);
    return next;
  }

  sessions(): SessionAgg[] {
    return [...this.sessionAggs.values()];
  }

  session(sessionId: string): SessionAgg | undefined {
    return this.sessionAggs.get(sessionId);
  }

  hourly(): Map<string, HourStats> {
    return this.hourBuckets;
  }

  byModel(): Map<string, ModelStats> {
    return this.modelBuckets;
  }

  /** Re-parses the tail of a session transcript to build its recent activity feed. */
  async recentActivity(
    sessionId: string,
    limit = 80,
  ): Promise<ActivityEvent[]> {
    const agg = this.sessionAggs.get(sessionId);
    if (!agg) return [];
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(agg.transcriptPath, "r");
    } catch {
      return [];
    }
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - ACTIVITY_TAIL_BYTES);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      if (start > 0) lines.shift(); // first line is likely truncated

      const events: ActivityEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = parseLine(line);
        if (entry?.activity && !entry.isSidechain) events.push(entry.activity);
      }
      return events.slice(-limit);
    } finally {
      await handle.close();
    }
  }

  private async readNewBytes(file: string): Promise<void> {
    let state = this.files.get(file);
    if (!state) {
      state = this.deriveFileState(file);
      this.files.set(file, state);
    }

    let size: number;
    try {
      ({ size } = await fsp.stat(file));
    } catch {
      return; // deleted between event and read
    }
    if (size < state.offset) {
      state.offset = 0;
      state.remainder = "";
    }
    if (size === state.offset) return;

    const handle = await fsp.open(file, "r");
    let changed = false;
    try {
      const buffer = Buffer.alloc(size - state.offset);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        state.offset,
      );
      state.offset += bytesRead;
      const text = state.remainder + buffer.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");
      state.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const applied = state.subAgentOf
          ? this.applySubAgentLine(line, state)
          : this.applyLine(line, file, state.projectSlug);
        if (applied) changed = true;
      }
    } finally {
      await handle.close();
    }
    if (changed) this.emit("update");
  }

  private applyLine(line: string, file: string, projectSlug: string): boolean {
    const entry = parseLine(line);
    if (!entry?.sessionId) return false;

    let agg = this.sessionAggs.get(entry.sessionId);
    if (!agg) {
      agg = this.newSessionAgg(entry.sessionId, projectSlug, file);
      this.sessionAggs.set(entry.sessionId, agg);
    }

    let changed = false;
    if (agg.missing) {
      agg.missing = false; // transcript reappeared on disk
      changed = true;
    }
    if (entry.cwd) agg.cwd = entry.cwd;
    if (entry.gitBranch && entry.gitBranch !== "HEAD")
      agg.gitBranch = entry.gitBranch;
    if (entry.timestamp) {
      if (!agg.firstTs || entry.timestamp < agg.firstTs)
        agg.firstTs = entry.timestamp;
      if (!agg.lastTs || entry.timestamp > agg.lastTs) {
        agg.lastTs = entry.timestamp;
        changed = true;
      }
    }
    if (entry.activity && !entry.isSidechain) {
      agg.lastActivity = entry.activity;
      if (entry.activity.kind === "user" && entry.activity.label === "PROMPT")
        agg.prompts += 1;
      changed = true;
    }
    // '<synthetic>' is Claude Code's placeholder model for internal error messages — no billable usage.
    if (
      entry.usage &&
      entry.model &&
      entry.model !== "<synthetic>" &&
      this.markUsageSeen(entry.sessionId, entry.dedupeKey)
    ) {
      const cost = this.pricing.costUSD(entry.model, entry.usage);
      agg.usage = addUsage(agg.usage, entry.usage);
      agg.costUSD += cost;
      agg.models.add(entry.model);
      this.bumpHour(entry.timestamp, entry.usage, cost);
      this.bumpModel(entry.model, entry.usage, cost);
      changed = true;
    }
    return changed;
  }

  private newSessionAgg(
    sessionId: string,
    projectSlug: string,
    transcriptPath: string,
  ): SessionAgg {
    return {
      sessionId,
      projectSlug,
      transcriptPath,
      models: new Set(),
      prompts: 0,
      usage: emptyUsage(),
      costUSD: 0,
      subAgents: new Map(),
      subAgentCostUSD: 0,
      missing: false,
    };
  }

  /** Builds per-file tail state, recognizing sub-agent transcripts by their path. */
  private deriveFileState(file: string): FileState {
    const parentDir = path.basename(path.dirname(file));
    if (parentDir === "subagents") {
      const sessionDir = path.dirname(path.dirname(file)); // {slug}/{sessionId}
      const sessionId = path.basename(sessionDir);
      const projectSlug = path.basename(path.dirname(sessionDir));
      const agentId = path
        .basename(file)
        .replace(/^agent-/, "")
        .replace(/\.jsonl$/, "");
      return {
        offset: 0,
        remainder: "",
        projectSlug,
        subAgentOf: sessionId,
        agentId,
      };
    }
    return { offset: 0, remainder: "", projectSlug: parentDir };
  }

  /** Aggregates one sub-agent transcript line into its parent session. */
  private applySubAgentLine(line: string, state: FileState): boolean {
    const entry = parseLine(line);
    if (!entry || !state.subAgentOf) return false;
    const sessionId = state.subAgentOf;
    const agentId = state.agentId ?? entry.agentId;
    if (!agentId) return false;

    let agg = this.sessionAggs.get(sessionId);
    if (!agg) {
      // Parent transcript not ingested yet — create a shell keyed to its main file.
      const transcriptPath = path.join(
        this.projectsDir,
        state.projectSlug,
        `${sessionId}.jsonl`,
      );
      agg = this.newSessionAgg(sessionId, state.projectSlug, transcriptPath);
      this.sessionAggs.set(sessionId, agg);
    }

    let sub = agg.subAgents.get(agentId);
    if (!sub) {
      sub = { agentId, models: new Set(), usage: emptyUsage(), costUSD: 0 };
      agg.subAgents.set(agentId, sub);
    }

    let changed = false;
    if (entry.attributionAgent && !sub.type) {
      sub.type = entry.attributionAgent;
      changed = true;
    }
    if (entry.timestamp) {
      if (!sub.firstTs || entry.timestamp < sub.firstTs)
        sub.firstTs = entry.timestamp;
      if (!sub.lastTs || entry.timestamp > sub.lastTs)
        sub.lastTs = entry.timestamp;
    }
    // The sub-agent's first user prompt is the task it was handed.
    if (
      !sub.taskPrompt &&
      entry.activity?.kind === "user" &&
      entry.activity.label === "PROMPT"
    ) {
      sub.taskPrompt = entry.activity.detail;
      changed = true;
    }
    if (
      entry.usage &&
      entry.model &&
      entry.model !== "<synthetic>" &&
      this.markUsageSeen(
        sessionId,
        entry.dedupeKey ? `sub:${agentId}:${entry.dedupeKey}` : undefined,
      )
    ) {
      const cost = this.pricing.costUSD(entry.model, entry.usage);
      sub.usage = addUsage(sub.usage, entry.usage);
      sub.costUSD += cost;
      sub.models.add(entry.model);
      // Roll sub-agent usage into parent session totals and global buckets.
      agg.usage = addUsage(agg.usage, entry.usage);
      agg.costUSD += cost;
      agg.subAgentCostUSD += cost;
      agg.models.add(entry.model);
      this.bumpHour(entry.timestamp, entry.usage, cost);
      this.bumpModel(entry.model, entry.usage, cost);
      changed = true;
    }
    return changed;
  }

  /** Streaming writes duplicate usage across lines sharing message.id — count once. */
  private markUsageSeen(
    sessionId: string,
    dedupeKey: string | undefined,
  ): boolean {
    if (!dedupeKey) return true;
    let seen = this.seenUsageKeys.get(sessionId);
    if (!seen) {
      seen = new Set();
      this.seenUsageKeys.set(sessionId, seen);
    }
    if (seen.has(dedupeKey)) return false;
    seen.add(dedupeKey);
    return true;
  }

  private bumpHour(
    timestamp: string | undefined,
    usage: UsageTotals,
    cost: number,
  ): void {
    if (!timestamp || timestamp.length < 13) return;
    const hour = timestamp.slice(0, 13); // "2026-07-13T09" (UTC)
    const bucket = this.hourBuckets.get(hour) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUSD: 0,
    };
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.cacheReadTokens += usage.cacheReadTokens;
    bucket.cacheWriteTokens +=
      usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
    bucket.costUSD += cost;
    this.hourBuckets.set(hour, bucket);

    if (this.hourBuckets.size > HOUR_PRUNE_THRESHOLD) {
      const oldest = new Date(Date.now() - HOUR_RETENTION_MS)
        .toISOString()
        .slice(0, 13);
      for (const key of this.hourBuckets.keys()) {
        if (key < oldest) this.hourBuckets.delete(key);
      }
    }
  }

  private bumpModel(model: string, usage: UsageTotals, cost: number): void {
    const bucket = this.modelBuckets.get(model) ?? {
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
    };
    bucket.inputTokens += usage.inputTokens;
    bucket.outputTokens += usage.outputTokens;
    bucket.costUSD += cost;
    this.modelBuckets.set(model, bucket);
  }
}
