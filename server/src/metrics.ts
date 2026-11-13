import type { LiveSession } from "./sessions.js";
import type {
  SessionAgg,
  SubAgentAgg,
  TranscriptStore,
} from "./transcripts.js";
import {
  emptyUsage,
  type FleetSession,
  type GlobalMetrics,
  type HourPoint,
  type PeriodStats,
  type PlannotatorSessionInfo,
  type SessionStatus,
  type SubAgentSummary,
} from "./types.js";

function toSubAgentSummary(sub: SubAgentAgg): SubAgentSummary {
  return {
    agentId: sub.agentId,
    type: sub.type,
    models: [...sub.models],
    usage: sub.usage,
    costUSD: sub.costUSD,
    firstTs: sub.firstTs,
    lastTs: sub.lastTs,
    taskPrompt: sub.taskPrompt,
  };
}

const ENDED_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENDED_SESSIONS = 20;
const HOUR_MS = 60 * 60 * 1000;
const STATUS_RANK: Record<SessionStatus, number> = {
  waiting: 0,
  busy: 1,
  idle: 2,
  missing: 3,
  ended: 4,
};

function tsToMs(ts: string | undefined): number {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? 0 : ms;
}

function mergeFleet(
  live: LiveSession | undefined,
  agg: SessionAgg | undefined,
): FleetSession {
  const status: SessionStatus = live
    ? live.status
    : agg?.missing
      ? "missing"
      : "ended";
  return {
    sessionId: live?.sessionId ?? agg?.sessionId ?? "",
    name: live?.name,
    nameSource: live?.nameSource,
    kind: live?.kind,
    agent: live?.agent,
    status,
    waitingFor: live?.waitingFor,
    pid: live?.pid,
    cwd: live?.cwd ?? agg?.cwd,
    projectSlug: agg?.projectSlug,
    gitBranch: agg?.gitBranch,
    headless: agg?.entrypoint === "sdk-cli",
    models: agg ? [...agg.models] : [],
    startedAt: (live?.startedAt ?? tsToMs(agg?.firstTs)) || undefined,
    statusUpdatedAt: live?.statusUpdatedAt,
    lastEventTs: agg?.lastTs,
    lastActivity: agg?.lastActivity,
    recap: agg?.recap,
    prompts: agg?.prompts ?? 0,
    advisorCalls: agg?.advisorCalls ?? 0,
    usage: agg?.usage ?? emptyUsage(),
    costUSD: agg?.costUSD ?? 0,
    subAgents: agg ? [...agg.subAgents.values()].map(toSubAgentSummary) : [],
    subAgentCostUSD: agg?.subAgentCostUSD ?? 0,
  };
}

export function buildFleet(
  live: LiveSession[],
  store: TranscriptStore,
  dismissed: ReadonlySet<string> = new Set(),
): FleetSession[] {
  const fleet: FleetSession[] = [];
  const liveIds = new Set<string>();

  for (const session of live) {
    liveIds.add(session.sessionId);
    fleet.push(mergeFleet(session, store.session(session.sessionId)));
  }

  const endedCutoff = Date.now() - ENDED_WINDOW_MS;
  const ended = store
    .sessions()
    .filter(
      (agg) =>
        !liveIds.has(agg.sessionId) &&
        !dismissed.has(agg.sessionId) &&
        tsToMs(agg.lastTs) >= endedCutoff,
    )
    .sort((a, b) => tsToMs(b.lastTs) - tsToMs(a.lastTs))
    .slice(0, MAX_ENDED_SESSIONS)
    .map((agg) => mergeFleet(undefined, agg));
  fleet.push(...ended);

  return fleet.sort((a, b) => {
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (rank !== 0) return rank;
    const aTs = Math.max(tsToMs(a.lastEventTs), a.statusUpdatedAt ?? 0);
    const bTs = Math.max(tsToMs(b.lastEventTs), b.statusUpdatedAt ?? 0);
    return bTs - aTs;
  });
}

/**
 * Grafts proven-owned Plannotator UIs onto their Claude session card. Sessions with
 * no `claudeSessionId` are deliberately dropped here — they stay visible only in the
 * global header counter. Returns new objects; `fleet` is not mutated.
 */
export function attachPlannotator(
  fleet: readonly FleetSession[],
  plannotator: readonly PlannotatorSessionInfo[],
): FleetSession[] {
  const bySession = new Map<string, PlannotatorSessionInfo[]>();
  for (const session of plannotator) {
    const owner = session.claudeSessionId;
    if (!owner) continue;
    const bucket = bySession.get(owner);
    if (bucket) bucket.push(session);
    else bySession.set(owner, [session]);
  }
  if (bySession.size === 0) return [...fleet];

  return fleet.map((session) => {
    const attached = bySession.get(session.sessionId);
    return attached ? { ...session, plannotator: attached } : { ...session };
  });
}

function periodStats(store: TranscriptStore, sinceMs: number): PeriodStats {
  const stats: PeriodStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUSD: 0,
    sessions: 0,
  };
  for (const [hour, bucket] of store.hourly()) {
    const bucketStart = Date.parse(`${hour}:00:00.000Z`);
    if (Number.isNaN(bucketStart) || bucketStart + HOUR_MS <= sinceMs) continue;
    stats.inputTokens += bucket.inputTokens;
    stats.outputTokens += bucket.outputTokens;
    stats.cacheReadTokens += bucket.cacheReadTokens;
    stats.cacheWriteTokens += bucket.cacheWriteTokens;
    stats.costUSD += bucket.costUSD;
  }
  stats.sessions = store
    .sessions()
    .filter((agg) => tsToMs(agg.lastTs) >= sinceMs).length;
  return stats;
}

function projectDisplayName(agg: SessionAgg): string {
  if (agg.cwd) {
    const base = agg.cwd.split("/").filter(Boolean).pop();
    if (base) return base;
  }
  return agg.projectSlug.split("-").filter(Boolean).pop() ?? agg.projectSlug;
}

export function buildMetrics(store: TranscriptStore): GlobalMetrics {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);

  const byProjectMap = new Map<
    string,
    { project: string; sessions: number; tokens: number; costUSD: number }
  >();
  for (const agg of store.sessions()) {
    const entry = byProjectMap.get(agg.projectSlug) ?? {
      project: projectDisplayName(agg),
      sessions: 0,
      tokens: 0,
      costUSD: 0,
    };
    entry.sessions += 1;
    entry.tokens += agg.usage.inputTokens + agg.usage.outputTokens;
    entry.costUSD += agg.costUSD;
    byProjectMap.set(agg.projectSlug, entry);
  }

  const now = Date.now();
  const timeline24h: HourPoint[] = [];
  for (let i = 23; i >= 0; i -= 1) {
    const hour = new Date(now - i * HOUR_MS).toISOString().slice(0, 13);
    const bucket = store.hourly().get(hour);
    timeline24h.push({
      hour,
      inputTokens: bucket?.inputTokens ?? 0,
      outputTokens: bucket?.outputTokens ?? 0,
      cacheReadTokens: bucket?.cacheReadTokens ?? 0,
      cacheWriteTokens: bucket?.cacheWriteTokens ?? 0,
      costUSD: bucket?.costUSD ?? 0,
    });
  }

  return {
    today: periodStats(store, midnight.getTime()),
    last7d: periodStats(store, now - 7 * 24 * HOUR_MS),
    byProject: [...byProjectMap.values()]
      .sort((a, b) => b.costUSD - a.costUSD)
      .slice(0, 10),
    byModel: [...store.byModel()]
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.costUSD - a.costUSD),
    timeline24h,
  };
}
