import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { getTask, listTasks, updateTask, type Task } from "./store.js";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable process runner: args are an array, never a shell string. */
export type Spawner = (
  bin: string,
  args: string[],
  opts: { cwd: string },
) => Promise<SpawnResult>;

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 200_000;
const MAX_ERROR_CHARS = 1_000;

export const defaultSpawner: Spawner = (bin, args, { cwd }) =>
  new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    const cap = (acc: string, chunk: Buffer): string =>
      acc.length < MAX_OUTPUT_BYTES ? acc + chunk.toString("utf8") : acc;
    child.stdout.on("data", (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on("data", (c: Buffer) => (stderr = cap(stderr, c)));
    child.on("error", (err) =>
      resolve({ code: null, stdout, stderr: `${stderr}${err.message}` }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

export interface ParsedOutput {
  sessionId: string | null;
  result: string;
  isError: boolean;
  costUsd: number | null;
  deniedTools: string[];
}

/** Parses `claude -p --output-format json` stdout (object, or array of events). */
export function parseClaudeOutput(stdout: string): ParsedOutput | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (Array.isArray(data))
    data = [...data]
      .reverse()
      .find((e) => (e as { type?: unknown } | null)?.type === "result");
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (typeof o.result !== "string") return null;
  // Defensive: `permission_denials` = [{ tool_name, tool_input }]; unknown shapes are ignored.
  const denials = Array.isArray(o.permission_denials) ? o.permission_denials : [];
  const deniedTools = [
    ...new Set(
      denials.flatMap((d) => {
        const n = (d as { tool_name?: unknown } | null)?.tool_name;
        return typeof n === "string" && n ? [n] : [];
      }),
    ),
  ];
  return {
    deniedTools,
    sessionId: typeof o.session_id === "string" ? o.session_id : null,
    result: o.result,
    isError: o.is_error === true,
    costUsd: typeof o.total_cost_usd === "number" ? o.total_cost_usd : null,
  };
}

export class TaskConflictError extends Error {}
export class TaskNotFoundError extends Error {}

export class TaskRunner extends EventEmitter {
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly db: Database.Database,
    private readonly bin = "claude",
    private readonly spawner: Spawner = defaultSpawner,
  ) {
    super();
  }

  /** Tasks left in_progress by a previous server process are lost: park them in waiting. */
  recoverInterrupted(): number {
    let n = 0;
    for (const t of listTasks(this.db)) {
      if (t.status !== "in_progress") continue;
      updateTask(this.db, t.id, {
        status: "waiting",
        error: "interrompue par redémarrage du serveur",
      });
      n++;
    }
    return n;
  }

  /** First launch (todo) or relaunch of a task whose first run failed (no session yet). */
  start(id: string): Task {
    const t = this.get(id);
    const relaunch = t.status === "waiting" && !t.sessionId;
    if (t.status !== "todo" && !relaunch)
      throw new TaskConflictError("task cannot be started in its current state");
    return this.launch(t, t.prompt, false);
  }

  reply(id: string, message: string): Task {
    const t = this.get(id);
    if (t.status !== "waiting" || !t.sessionId)
      throw new TaskConflictError("task is not waiting for a reply");
    return this.launch(t, message, true);
  }

  /** Resolves when the task's current process (if any) has finished. */
  whenSettled(id: string): Promise<void> {
    return this.running.get(id) ?? Promise.resolve();
  }

  private get(id: string): Task {
    const t = getTask(this.db, id);
    if (!t) throw new TaskNotFoundError("task not found");
    if (t.status === "in_progress" || this.running.has(id))
      throw new TaskConflictError("task already in progress");
    return t;
  }

  private launch(t: Task, text: string, resume: boolean): Task {
    // `--` ends option parsing so a prompt starting with "-" stays a prompt.
    const args = [
      "-p",
      "--output-format",
      "json",
      ...(t.model ? ["--model", t.model] : []),
      "--permission-mode",
      t.permissionMode,
      ...(t.allowedTools?.length
        ? ["--allowedTools", t.allowedTools.join(",")]
        : []),
      ...(resume && t.sessionId ? ["--resume", t.sessionId] : []),
      "--",
      text,
    ];
    const started = updateTask(this.db, t.id, {
      status: "in_progress",
      error: null,
      deniedTools: [],
    }) as Task;
    const run = this.spawner(this.bin, args, { cwd: t.cwd })
      .then((res) => this.finish(t, res))
      .catch((err: unknown) =>
        this.fail(t.id, err instanceof Error ? err.message : "spawn failed"),
      )
      .finally(() => {
        this.running.delete(t.id);
        this.emit("change");
      });
    this.running.set(t.id, run);
    this.emit("change");
    return started;
  }

  private finish(t: Task, res: SpawnResult): void {
    const out = parseClaudeOutput(res.stdout);
    if (!out) {
      const detail = res.stderr.trim().slice(0, MAX_ERROR_CHARS);
      this.fail(
        t.id,
        res.code === 0
          ? "sortie de claude illisible"
          : `claude a échoué (code ${res.code ?? "?"})${detail ? ` : ${detail}` : ""}`,
      );
      return;
    }
    // total_cost_usd is cumulative for the whole session (verified with --resume): replace, never add.
    const cost = out.costUsd ?? t.costUsd;
    updateTask(this.db, t.id, {
      status: "waiting",
      sessionId: out.sessionId ?? t.sessionId,
      lastResult: out.result.slice(0, MAX_RESULT_CHARS),
      error: out.isError || res.code ? out.result.slice(0, MAX_ERROR_CHARS) || "erreur claude" : null,
      costUsd: cost,
      deniedTools: out.deniedTools,
    });
  }

  private fail(id: string, error: string): void {
    updateTask(this.db, id, { status: "waiting", error });
  }
}
