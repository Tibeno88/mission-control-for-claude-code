import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../src/backup/db.js";
import {
  parseClaudeOutput,
  TaskConflictError,
  TaskRunner,
  type Spawner,
  type SpawnResult,
} from "../src/tasks/runner.js";
import { createTask, getTask, updateTask } from "../src/tasks/store.js";

const ok = (over: Record<string, unknown> = {}): SpawnResult => ({
  code: 0,
  stderr: "",
  stdout: JSON.stringify({
    type: "result",
    session_id: "sess-1",
    result: "hello",
    is_error: false,
    total_cost_usd: 0.5,
    ...over,
  }),
});

describe("parseClaudeOutput", () => {
  test("parses the final result object", () => {
    expect(parseClaudeOutput(ok().stdout)).toEqual({
      sessionId: "sess-1",
      result: "hello",
      isError: false,
      costUsd: 0.5,
      deniedTools: [],
    });
  });
  test("collects deduplicated permission_denials, ignores bad shapes", () => {
    const out = ok({
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "plannotator x" } },
        { tool_name: "Bash", tool_input: {} },
        { tool_name: "Edit" },
        null,
        { foo: 1 },
      ],
    }).stdout;
    expect(parseClaudeOutput(out)?.deniedTools).toEqual(["Bash", "Edit"]);
    expect(parseClaudeOutput(ok({ permission_denials: "x" }).stdout)?.deniedTools).toEqual([]);
  });
  test("picks the result event of an array", () => {
    const out = JSON.stringify([{ type: "system" }, JSON.parse(ok().stdout)]);
    expect(parseClaudeOutput(out)?.result).toBe("hello");
  });
  test("returns null on invalid JSON or missing result", () => {
    expect(parseClaudeOutput("not json")).toBeNull();
    expect(parseClaudeOutput("{}")).toBeNull();
  });
});

describe("TaskRunner", () => {
  let root: string;
  let db: Database.Database;
  let calls: Array<{ bin: string; args: string[]; cwd: string }>;
  let next: () => Promise<SpawnResult>;
  const spawner: Spawner = (bin, args, opts) => {
    calls.push({ bin, args, cwd: opts.cwd });
    return next();
  };
  const mk = () =>
    createTask(db, {
      title: "t",
      prompt: "do it",
      cwd: root,
      model: "sonnet",
      permissionMode: "plan",
      allowedTools: ["Read", "Bash(git status:*)"],
    });

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-tasks-"));
    db = openDb(path.join(root, "cmc.db"));
    calls = [];
    next = async () => ok();
  });
  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("todo -> in_progress -> waiting with result, session and cost", async () => {
    const runner = new TaskRunner(db, "fake-claude", spawner);
    const t = mk();
    expect(runner.start(t.id).status).toBe("in_progress");
    await runner.whenSettled(t.id);
    const done = getTask(db, t.id)!;
    expect(done).toMatchObject({
      status: "waiting",
      sessionId: "sess-1",
      lastResult: "hello",
      error: null,
      costUsd: 0.5,
    });
    expect(calls[0]).toEqual({
      bin: "fake-claude",
      cwd: root,
      args: [
        "-p", "--output-format", "json", "--model", "sonnet",
        "--permission-mode", "plan",
        "--allowedTools", "Read,Bash(git status:*)", "--", "do it",
      ],
    });
  });

  test("reply resumes the session and keeps the cumulative cost reported by claude", async () => {
    const runner = new TaskRunner(db, "c", spawner);
    const t = mk();
    runner.start(t.id);
    await runner.whenSettled(t.id);
    next = async () => ok({ total_cost_usd: 1 });
    runner.reply(t.id, "-continue");
    await runner.whenSettled(t.id);
    expect(calls[1]!.args).toContain("--resume");
    expect(calls[1]!.args.slice(-2)).toEqual(["--", "-continue"]);
    expect(getTask(db, t.id)!.costUsd).toBe(1);
  });

  test("rejects a second start while in progress (409 error)", async () => {
    let release!: () => void;
    next = () => new Promise((r) => (release = () => r(ok())));
    const runner = new TaskRunner(db, "c", spawner);
    const t = mk();
    runner.start(t.id);
    expect(() => runner.start(t.id)).toThrow(TaskConflictError);
    expect(() => runner.reply(t.id, "x")).toThrow(TaskConflictError);
    release();
    await runner.whenSettled(t.id);
    expect(() => runner.start(t.id)).toThrow(TaskConflictError); // has a session now
  });

  test("failing process -> waiting with error, relaunchable", async () => {
    next = async () => ({ code: 1, stdout: "", stderr: "boom" });
    const runner = new TaskRunner(db, "c", spawner);
    const t = mk();
    runner.start(t.id);
    await runner.whenSettled(t.id);
    const failed = getTask(db, t.id)!;
    expect(failed.status).toBe("waiting");
    expect(failed.error).toContain("boom");
    expect(runner.start(t.id).status).toBe("in_progress");
    await runner.whenSettled(t.id);
  });

  test("invalid JSON and is_error both surface an error", async () => {
    const runner = new TaskRunner(db, "c", spawner);
    next = async () => ({ code: 0, stdout: "garbage", stderr: "" });
    const a = mk();
    runner.start(a.id);
    await runner.whenSettled(a.id);
    expect(getTask(db, a.id)!.error).toMatch(/illisible/);

    next = async () => ok({ is_error: true, result: "rate limited" });
    const b = mk();
    runner.start(b.id);
    await runner.whenSettled(b.id);
    expect(getTask(db, b.id)).toMatchObject({
      status: "waiting",
      error: "rate limited",
    });
  });

  test("rejecting spawner is handled", async () => {
    next = () => Promise.reject(new Error("ENOENT"));
    const runner = new TaskRunner(db, "c", spawner);
    const t = mk();
    runner.start(t.id);
    await runner.whenSettled(t.id);
    expect(getTask(db, t.id)).toMatchObject({ status: "waiting", error: "ENOENT" });
  });

  test("recoverInterrupted parks in_progress tasks in waiting", () => {
    const runner = new TaskRunner(db, "c", spawner);
    const t = mk();
    updateTask(db, t.id, { status: "in_progress" });
    expect(runner.recoverInterrupted()).toBe(1);
    expect(getTask(db, t.id)).toMatchObject({
      status: "waiting",
      error: "interrompue par redémarrage du serveur",
    });
  });
});
