import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Context, Hono, Next } from "hono";
import {
  TaskConflictError,
  TaskNotFoundError,
  type TaskRunner,
} from "./runner.js";
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  type TaskStatus,
} from "./store.js";

const ID_RE = /^[0-9a-f-]{36}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
// Names of the installed CLI (`claude --permission-mode`); bypassPermissions is deliberately absent.
const PERMISSION_MODES: readonly string[] = ["manual", "acceptEdits", "auto", "plan"];
// One tool spec, e.g. `Read`, `Bash(git status:*)`, `mcp__srv__tool`; no comma (list separator), no leading dash.
const TOOL_RE = /^[A-Za-z_][A-Za-z0-9_ .:*/()@=\\[\]-]{0,199}$/;
const MAX_TOOLS = 50;
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);
const MAX_TITLE = 200;
const MAX_TEXT = 20_000;

/** Statuses a user may set through PATCH (in_progress/waiting are runner-owned). */
const USER_STATUSES: readonly string[] = ["todo", "done", "archived"];

const validTools = (t: unknown): t is string[] | null =>
  t === null ||
  (Array.isArray(t) &&
    t.length <= MAX_TOOLS &&
    t.every((x) => typeof x === "string" && TOOL_RE.test(x)));

function hostnameOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Anti-CSRF / DNS-rebinding guard for routes that end up running `claude`:
 * JSON content type (forces a CORS preflight cross-origin), local Host, and an
 * Origin (when sent) that is local and same-origin with Host.
 */
export async function localMutationGuard(c: Context, next: Next) {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const host = c.req.header("host");
  if (!LOCAL_HOSTNAMES.has(hostnameOf(host) ?? ""))
    return c.json({ error: "forbidden host" }, 403);
  const origin = c.req.header("origin");
  if (origin !== undefined) {
    let o: URL | undefined;
    try {
      o = new URL(origin);
    } catch {
      o = undefined;
    }
    if (!o || !LOCAL_HOSTNAMES.has(o.hostname) || o.host !== host)
      return c.json({ error: "forbidden origin" }, 403);
  }
  const ct = c.req.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(ct))
    return c.json({ error: "content-type must be application/json" }, 415);
  return next();
}

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" && v.length <= max ? v : null;

function validCwd(v: unknown): string | null {
  if (typeof v !== "string" || !path.isAbsolute(v) || v.length > 4096)
    return null;
  try {
    return fs.statSync(v).isDirectory() ? v : null;
  } catch {
    return null;
  }
}

async function readBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const b: unknown = await c.req.json();
    return b && typeof b === "object" && !Array.isArray(b)
      ? (b as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function registerTaskRoutes(
  app: Hono,
  deps: { db: Database.Database; runner: TaskRunner },
): void {
  const { db, runner } = deps;

  app.use("/api/tasks", localMutationGuard);
  app.use("/api/tasks/*", localMutationGuard);

  const withTask = (c: Context, fn: (id: string) => unknown): Response => {
    const id = c.req.param("id") ?? "";
    if (!ID_RE.test(id)) return c.json({ error: "invalid task id" }, 400);
    try {
      return c.json({ task: fn(id) });
    } catch (e) {
      if (e instanceof TaskNotFoundError)
        return c.json({ error: e.message }, 404);
      if (e instanceof TaskConflictError)
        return c.json({ error: e.message }, 409);
      return c.json({ error: "internal error" }, 500);
    }
  };

  app.get("/api/tasks", (c) => c.json({ tasks: listTasks(db) }));

  app.post("/api/tasks", async (c) => {
    const b = await readBody(c);
    if (!b) return c.json({ error: "invalid JSON body" }, 400);
    const title = str(b.title, MAX_TITLE);
    const prompt = str(b.prompt, MAX_TEXT);
    const cwd = validCwd(b.cwd);
    const permissionMode = b.permissionMode ?? "manual";
    const tools = b.allowedTools ?? null;
    const model =
      b.model === undefined || b.model === null || b.model === ""
        ? null
        : b.model;
    if (!title) return c.json({ error: "invalid title" }, 400);
    if (!prompt) return c.json({ error: "invalid prompt" }, 400);
    if (!cwd)
      return c.json(
        { error: "cwd must be an existing absolute directory" },
        400,
      );
    if (
      typeof permissionMode !== "string" ||
      !PERMISSION_MODES.includes(permissionMode)
    )
      return c.json({ error: "invalid permissionMode" }, 400);
    if (!validTools(tools))
      return c.json({ error: "invalid allowedTools" }, 400);
    if (model !== null && (typeof model !== "string" || !MODEL_RE.test(model)))
      return c.json({ error: "invalid model" }, 400);
    const task = createTask(db, {
      title,
      prompt,
      cwd,
      model,
      permissionMode,
      allowedTools: tools as string[] | null,
    });
    runner.emit("change");
    return c.json({ task }, 201);
  });

  app.post("/api/tasks/:id/start", (c) =>
    withTask(c, (id) => runner.start(id)),
  );

  app.post("/api/tasks/:id/reply", async (c) => {
    const b = await readBody(c);
    const message = b ? str(b.message, MAX_TEXT) : null;
    if (!message) return c.json({ error: "invalid message" }, 400);
    return withTask(c, (id) => runner.reply(id, message));
  });

  app.patch("/api/tasks/:id", async (c) => {
    const b = await readBody(c);
    if (!b) return c.json({ error: "invalid JSON body" }, 400);
    const patch: {
      title?: string;
      prompt?: string;
      status?: TaskStatus;
      allowedTools?: string[] | null;
      permissionMode?: string;
    } = {};
    if (b.permissionMode !== undefined) {
      if (typeof b.permissionMode !== "string" || !PERMISSION_MODES.includes(b.permissionMode))
        return c.json({ error: "invalid permissionMode" }, 400);
      patch.permissionMode = b.permissionMode;
    }
    if (b.allowedTools !== undefined) {
      if (!validTools(b.allowedTools))
        return c.json({ error: "invalid allowedTools" }, 400);
      patch.allowedTools = b.allowedTools;
    }
    if (b.title !== undefined) {
      const v = str(b.title, MAX_TITLE);
      if (!v) return c.json({ error: "invalid title" }, 400);
      patch.title = v;
    }
    if (b.prompt !== undefined) {
      const v = str(b.prompt, MAX_TEXT);
      if (!v) return c.json({ error: "invalid prompt" }, 400);
      patch.prompt = v;
    }
    if (b.status !== undefined) {
      if (typeof b.status !== "string" || !USER_STATUSES.includes(b.status))
        return c.json({ error: "invalid status" }, 400);
      patch.status = b.status as TaskStatus;
    }
    const res = withTask(c, (id) => {
      const t = getTask(db, id);
      if (!t) throw new TaskNotFoundError("task not found");
      if (t.status === "in_progress")
        throw new TaskConflictError("task is in progress");
      if (patch.status === "todo") {
        // Only archived tasks go "back"; they return to where the session left off.
        if (t.status !== "archived")
          throw new TaskConflictError("invalid transition");
        patch.status = t.sessionId ? "waiting" : "todo";
      }
      return updateTask(db, id, patch);
    });
    runner.emit("change");
    return res;
  });
}
