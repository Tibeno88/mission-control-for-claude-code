import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { attachPlannotator } from "../src/metrics.js";
import {
  parsePlannotatorSession,
  PlannotatorRegistry,
  resolveOwners,
} from "../src/plannotator.js";
import { ancestorPids, parseProcStat, type StatReader } from "../src/proc.js";
import type { LiveSession } from "../src/sessions.js";
import { emptyUsage, type FleetSession } from "../src/types.js";

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION_ID = "99999999-8888-7777-6666-555555555555";
/** A guaranteed-dead PID: the kernel maximum is 4194304 on 64-bit Linux. */
const DEAD_PID = 4194303;

function sessionFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    port: 8731,
    url: "http://localhost:8731/",
    mode: "annotate",
    project: "repo-a",
    startedAt: "2026-08-17T09:14:22.108Z",
    label: "annotate-last",
    ...overrides,
  });
}

/** Builds a StatReader over a plain {pid: {ppid, startTime}} graph. */
function fakeReader(
  graph: Record<number, { ppid: number; startTime: number }>,
): StatReader {
  return (pid) => {
    const node = graph[pid];
    if (!node) return null;
    // Deliberately nasty comm to exercise the parser. The filler is sized so that
    // startTime lands exactly on field 22 of /proc/<pid>/stat.
    return `${pid} (weird (proc) name) S ${node.ppid} 1 1 0 -1 4194304 ${"0 ".repeat(12)}${node.startTime} 0 0`;
  };
}

function fleetSession(sessionId: string): FleetSession {
  return {
    sessionId,
    status: "busy",
    models: [],
    prompts: 0,
    usage: emptyUsage(),
    costUSD: 0,
    subAgents: [],
    subAgentCostUSD: 0,
  };
}

function liveSession(pid: number, sessionId: string): LiveSession {
  return { pid, sessionId, status: "busy" };
}

describe("parsePlannotatorSession", () => {
  test("accepts a well-formed live entry and normalises startedAt to epoch ms", () => {
    const parsed = parsePlannotatorSession(JSON.parse(sessionFile()));
    expect(parsed).not.toBeNull();
    expect(parsed?.pid).toBe(process.pid);
    expect(parsed?.mode).toBe("annotate");
    expect(parsed?.label).toBe("annotate-last");
    expect(parsed?.startedAt).toBe(Date.parse("2026-08-17T09:14:22.108Z"));
  });

  test("rejects a dead pid", () => {
    const parsed = parsePlannotatorSession(
      JSON.parse(sessionFile({ pid: DEAD_PID })),
    );
    expect(parsed).toBeNull();
  });

  test.each([["javascript:alert(1)"], ["file:///etc/passwd"], ["not a url"]])(
    "rejects unsafe url %p",
    (url) => {
      expect(
        parsePlannotatorSession(JSON.parse(sessionFile({ url }))),
      ).toBeNull();
    },
  );

  test("rejects a missing mode", () => {
    expect(
      parsePlannotatorSession(JSON.parse(sessionFile({ mode: undefined }))),
    ).toBeNull();
  });
});

describe("PlannotatorRegistry", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-plannotator-"));
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("lists live entries newest first and skips non-json files", async () => {
    await fsp.writeFile(
      path.join(root, `${process.pid}.json`),
      sessionFile({ startedAt: "2026-08-17T09:00:00.000Z" }),
    );
    await fsp.writeFile(
      path.join(root, `${process.pid + 1}.json`),
      sessionFile({
        port: 8732,
        url: "http://localhost:8732/",
        mode: "review",
        startedAt: "2026-08-17T10:00:00.000Z",
      }),
    );
    await fsp.writeFile(path.join(root, "notes.txt"), "ignored");

    const registry = new PlannotatorRegistry(root, 60_000);
    await registry.refresh();

    const sessions = registry.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.mode).toBe("review");
    expect(sessions[1]?.mode).toBe("annotate");
  });

  test("drops malformed json and dead pids", async () => {
    await fsp.writeFile(path.join(root, "1.json"), "{ not json");
    await fsp.writeFile(
      path.join(root, "2.json"),
      sessionFile({ pid: DEAD_PID }),
    );

    const registry = new PlannotatorRegistry(root, 60_000);
    await registry.refresh();

    expect(registry.list()).toEqual([]);
  });

  test("returns an empty list when the directory does not exist", async () => {
    const registry = new PlannotatorRegistry(path.join(root, "absent"), 60_000);
    await registry.refresh();
    expect(registry.list()).toEqual([]);
  });

  // Plannotator is an optional dependency: a machine without it must still boot.
  test("starts without throwing when the directory does not exist", async () => {
    const registry = new PlannotatorRegistry(path.join(root, "absent"), 60_000);
    await expect(registry.start()).resolves.toBeUndefined();
    expect(registry.list()).toEqual([]);
    await registry.stop();
  });

  test("attributes a session to the Claude process that spawned it", async () => {
    await fsp.writeFile(path.join(root, `${process.pid}.json`), sessionFile());

    const claudePid = 500;
    const read = fakeReader({
      [process.pid]: { ppid: 400, startTime: 900 },
      400: { ppid: claudePid, startTime: 800 },
      [claudePid]: { ppid: 2, startTime: 100 },
    });
    const registry = new PlannotatorRegistry(root, 60_000, read);
    await registry.refresh();

    const [attributed] = registry.listAttributed([
      liveSession(claudePid, SESSION_ID),
    ]);
    expect(attributed?.claudeSessionId).toBe(SESSION_ID);
    // list() stays unattributed — the header counter shows every live UI.
    expect(registry.list()[0]?.claudeSessionId).toBeUndefined();
  });

  test("leaves a session unattached when no ancestor is a Claude session", async () => {
    await fsp.writeFile(path.join(root, `${process.pid}.json`), sessionFile());

    const read = fakeReader({
      [process.pid]: { ppid: 400, startTime: 900 },
      400: { ppid: 2, startTime: 800 },
    });
    const registry = new PlannotatorRegistry(root, 60_000, read);
    await registry.refresh();

    const [attributed] = registry.listAttributed([
      liveSession(500, SESSION_ID),
    ]);
    expect(attributed?.claudeSessionId).toBeUndefined();
  });
});

describe("parseProcStat", () => {
  test("handles a comm containing spaces and parentheses", () => {
    const stat = `1234 (my (weird) proc) S 4242 ${"0 ".repeat(17)}987654 0 0`;
    expect(parseProcStat(stat)).toEqual({ ppid: 4242, startTime: 987654 });
  });

  test("returns null on a line without a closing parenthesis", () => {
    expect(parseProcStat("garbage")).toBeNull();
  });
});

describe("ancestorPids", () => {
  test("walks the chain nearest-ancestor first and stops at init", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 300 },
      20: { ppid: 30, startTime: 200 },
      30: { ppid: 1, startTime: 100 },
    });
    expect(ancestorPids(10, read)).toEqual([20, 30]);
  });

  test("respects maxDepth", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 300 },
      20: { ppid: 30, startTime: 200 },
      30: { ppid: 40, startTime: 100 },
      40: { ppid: 2, startTime: 50 },
    });
    expect(ancestorPids(10, read, 2)).toEqual([20, 30]);
  });

  test("breaks out of a ppid cycle", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 300 },
      20: { ppid: 10, startTime: 200 },
    });
    expect(ancestorPids(10, read)).toEqual([20]);
  });

  test("returns [] when /proc is unreadable", () => {
    expect(ancestorPids(10, () => null)).toEqual([]);
  });
});

describe("resolveOwners", () => {
  const plannotatorSession = {
    pid: 10,
    port: 8731,
    url: "http://localhost:8731/",
    mode: "annotate",
    project: "repo-a",
    startedAt: 1,
  };

  test("never falls back to the project name", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 300 },
      20: { ppid: 2, startTime: 200 },
    });
    // Same project, but not an ancestor: must stay unattached.
    const live = [
      { ...liveSession(999, SESSION_ID), cwd: "/home/user/repo-a" },
    ];
    expect(resolveOwners([plannotatorSession], live, read).size).toBe(0);
  });

  test("attributes to the nearest matching ancestor", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 300 },
      20: { ppid: 30, startTime: 200 },
      30: { ppid: 2, startTime: 100 },
    });
    const owners = resolveOwners(
      [plannotatorSession],
      [liveSession(30, OTHER_SESSION_ID), liveSession(20, SESSION_ID)],
      read,
    );
    expect(owners.get(10)).toBe(SESSION_ID);
  });

  test("rejects a reused pid whose Claude candidate started later", () => {
    const read = fakeReader({
      10: { ppid: 20, startTime: 100 },
      // Claude "started" after its supposed descendant — the pid was recycled.
      20: { ppid: 2, startTime: 900 },
    });
    const owners = resolveOwners(
      [plannotatorSession],
      [liveSession(20, SESSION_ID)],
      read,
    );
    expect(owners.size).toBe(0);
  });
});

describe("attachPlannotator", () => {
  const owned = {
    pid: 10,
    port: 8731,
    url: "http://localhost:8731/",
    mode: "annotate",
    project: "repo-a",
    startedAt: 1,
    claudeSessionId: SESSION_ID,
  };

  test("grafts owned sessions and ignores unattached ones", () => {
    const fleet = [fleetSession(SESSION_ID), fleetSession(OTHER_SESSION_ID)];
    const result = attachPlannotator(fleet, [
      owned,
      {
        pid: 11,
        port: 8732,
        url: "http://localhost:8732/",
        mode: "review",
        project: "repo-b",
        startedAt: 2,
      },
    ]);

    expect(result[0]?.plannotator).toHaveLength(1);
    expect(result[0]?.plannotator?.[0]?.pid).toBe(10);
    expect(result[1]?.plannotator).toBeUndefined();
  });

  test("does not mutate the input fleet", () => {
    const fleet = [fleetSession(SESSION_ID)];
    attachPlannotator(fleet, [owned]);
    expect(fleet[0]?.plannotator).toBeUndefined();
  });
});
