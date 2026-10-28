import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type TaskStatus =
  | "todo"
  | "in_progress"
  | "waiting"
  | "done"
  | "archived";

export interface Task {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  /** null = all tools (CLI default for the execution context). */
  allowedTools: string[] | null;
  /** Tools refused during the last run (from `permission_denials`). */
  deniedTools: string[];
  status: TaskStatus;
  sessionId: string | null;
  lastResult: string | null;
  error: string | null;
  costUsd: number | null;
  createdAt: number;
  updatedAt: number;
}

interface TaskRow {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permission_mode: string;
  allowed_tools: string | null;
  denied_tools: string | null;
  status: TaskStatus;
  session_id: string | null;
  last_result: string | null;
  error: string | null;
  cost_usd: number | null;
  created_at: number;
  updated_at: number;
}

const toTask = (r: TaskRow): Task => ({
  id: r.id,
  title: r.title,
  prompt: r.prompt,
  cwd: r.cwd,
  model: r.model,
  permissionMode: r.permission_mode,
  allowedTools: r.allowed_tools ? (JSON.parse(r.allowed_tools) as string[]) : null,
  deniedTools: r.denied_tools ? (JSON.parse(r.denied_tools) as string[]) : [],
  status: r.status,
  sessionId: r.session_id,
  lastResult: r.last_result,
  error: r.error,
  costUsd: r.cost_usd,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface NewTask {
  title: string;
  prompt: string;
  cwd: string;
  model: string | null;
  permissionMode: string;
  allowedTools: string[] | null;
}

/** Columns that `updateTask` may write (camelCase key -> SQL column). */
const COLUMNS = {
  title: "title",
  prompt: "prompt",
  status: "status",
  sessionId: "session_id",
  lastResult: "last_result",
  error: "error",
  costUsd: "cost_usd",
  allowedTools: "allowed_tools",
  deniedTools: "denied_tools",
} as const;

export type TaskPatch = Partial<
  Pick<Task, keyof typeof COLUMNS>
>;

export function createTask(db: Database.Database, input: NewTask): Task {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, prompt, cwd, model, permission_mode, allowed_tools, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
  ).run(
    id,
    input.title,
    input.prompt,
    input.cwd,
    input.model,
    input.permissionMode,
    input.allowedTools?.length ? JSON.stringify(input.allowedTools) : null,
    now,
    now,
  );
  return getTask(db, id) as Task;
}

export function getTask(db: Database.Database, id: string): Task | undefined {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | TaskRow
    | undefined;
  return row ? toTask(row) : undefined;
}

export function listTasks(db: Database.Database): Task[] {
  return (
    db
      .prepare("SELECT * FROM tasks ORDER BY created_at ASC, rowid ASC")
      .all() as TaskRow[]
  ).map(toTask);
}

export function updateTask(
  db: Database.Database,
  id: string,
  patch: TaskPatch,
): Task | undefined {
  const keys = (Object.keys(patch) as Array<keyof TaskPatch>).filter(
    (k) => k in COLUMNS,
  );
  const sets = keys.map((k) => `${COLUMNS[k]} = ?`);
  const values = keys.map((k) => {
    const v = patch[k] ?? null;
    return Array.isArray(v) ? (v.length ? JSON.stringify(v) : null) : v;
  });
  db.prepare(
    `UPDATE tasks SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
  ).run(...values, Date.now(), id);
  return getTask(db, id);
}
