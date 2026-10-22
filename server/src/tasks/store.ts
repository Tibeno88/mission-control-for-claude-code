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
} as const;

export type TaskPatch = Partial<
  Pick<Task, keyof typeof COLUMNS>
>;

export function createTask(db: Database.Database, input: NewTask): Task {
  const now = Date.now();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO tasks (id, title, prompt, cwd, model, permission_mode, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'todo', ?, ?)`,
  ).run(
    id,
    input.title,
    input.prompt,
    input.cwd,
    input.model,
    input.permissionMode,
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
  const values = keys.map((k) => patch[k] ?? null);
  db.prepare(
    `UPDATE tasks SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`,
  ).run(...values, Date.now(), id);
  return getTask(db, id);
}
