import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { openDb } from "../src/backup/db.js";
import { registerTaskRoutes } from "../src/tasks/api.js";
import { TaskRunner, type Spawner } from "../src/tasks/runner.js";

const result = JSON.stringify({ session_id: "s1", result: "r", is_error: false });

describe("tasks/api", () => {
  let root: string;
  let db: Database.Database;
  let app: Hono;
  let runner: TaskRunner;
  let release: (() => void) | undefined;
  let hold = false;

  const spawner: Spawner = () =>
    hold
      ? new Promise((r) => (release = () => r({ code: 0, stdout: result, stderr: "" })))
      : Promise.resolve({ code: 0, stdout: result, stderr: "" });

  const H = {
    host: "127.0.0.1:4517",
    "content-type": "application/json",
  };
  const call = (method: string, url: string, body?: unknown, headers = H) =>
    app.request(url, {
      method,
      headers,
      body: body === undefined ? "{}" : JSON.stringify(body),
    });
  const valid = () => ({ title: "T", prompt: "P", cwd: root });
  const create = async (): Promise<string> =>
    ((await (await call("POST", "/api/tasks", valid())).json()) as any).task.id;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "cmc-tasks-api-"));
    db = openDb(path.join(root, "cmc.db"));
    runner = new TaskRunner(db, "c", spawner);
    app = new Hono();
    registerTaskRoutes(app, { db, runner });
    hold = false;
  });
  afterEach(async () => {
    db.close();
    await fsp.rm(root, { recursive: true, force: true });
  });

  test("creates and lists a todo task", async () => {
    const res = await call("POST", "/api/tasks", valid());
    expect(res.status).toBe(201);
    const list = (await (await app.request("/api/tasks")).json()) as any;
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0].status).toBe("todo");
  });

  test.each([
    ["foreign Origin", { ...H, origin: "http://evil.example" }],
    ["foreign Host (rebinding)", { ...H, host: "evil.example:4517" }],
    ["Origin not matching Host", { ...H, origin: "http://localhost:9999" }],
    ["non-JSON content type", { host: H.host, "content-type": "text/plain" }],
  ])("refuses %s", async (_n, headers) => {
    const res = await call("POST", "/api/tasks", valid(), headers);
    expect([403, 415]).toContain(res.status);
    expect(db.prepare("SELECT COUNT(*) n FROM tasks").get()).toEqual({ n: 0 });
  });

  test("accepts same-origin local Origin", async () => {
    const res = await call("POST", "/api/tasks", valid(), {
      ...H,
      origin: "http://localhost:4517",
      host: "localhost:4517",
    });
    expect(res.status).toBe(201);
  });

  test("PATCH permissionMode: accepts auto, rejects bypassPermissions", async () => {
    const id = (await (await call("POST", "/api/tasks", valid())).json()).task.id;
    const ok = await call("PATCH", `/api/tasks/${id}`, { permissionMode: "auto" });
    expect((await ok.json()).task.permissionMode).toBe("auto");
    const bad = await call("PATCH", `/api/tasks/${id}`, { permissionMode: "bypassPermissions" });
    expect(bad.status).toBe(400);
  });

  test.each([
    ["relative cwd", { cwd: "relative/dir" }],
    ["missing cwd", { cwd: "/definitely/not/here" }],
    ["file cwd", { cwd: "__FILE__" }],
    ["bypassPermissions", { permissionMode: "bypassPermissions" }],
    ["bad model", { model: "x; rm -rf /" }],
    ["empty title", { title: "  " }],
    ["huge prompt", { prompt: "a".repeat(20_001) }],
  ])("400 on %s", async (_n, over) => {
    const body: Record<string, unknown> = { ...valid(), ...over };
    if (body.cwd === "__FILE__") {
      body.cwd = path.join(root, "f.txt");
      await fsp.writeFile(body.cwd as string, "x");
    }
    expect((await call("POST", "/api/tasks", body)).status).toBe(400);
  });

  test("400 on invalid id, 404 on unknown id", async () => {
    expect((await call("POST", "/api/tasks/nope/start")).status).toBe(400);
    const unknown = "00000000-0000-0000-0000-000000000000";
    expect((await call("POST", `/api/tasks/${unknown}/start`)).status).toBe(404);
  });

  test("409 on double start", async () => {
    hold = true;
    const id = await create();
    expect((await call("POST", `/api/tasks/${id}/start`)).status).toBe(200);
    expect((await call("POST", `/api/tasks/${id}/start`)).status).toBe(409);
    release!();
    await runner.whenSettled(id);
  });

  test("start, reply, done, archive, restore", async () => {
    const id = await create();
    await call("POST", `/api/tasks/${id}/start`);
    await runner.whenSettled(id);
    expect((await call("POST", `/api/tasks/${id}/reply`, {})).status).toBe(400);
    expect((await call("POST", `/api/tasks/${id}/reply`, { message: "go" })).status).toBe(200);
    await runner.whenSettled(id);
    const patch = async (status: string) =>
      (await (await call("PATCH", `/api/tasks/${id}`, { status })).json()) as any;
    expect((await patch("done")).task.status).toBe("done");
    expect((await patch("archived")).task.status).toBe("archived");
    expect((await patch("todo")).task.status).toBe("waiting"); // restore: session exists
    expect((await call("PATCH", `/api/tasks/${id}`, { status: "in_progress" })).status).toBe(400);
  });

  test("PATCH allowedTools: valid stored, invalid rejected", async () => {
    const id = await create();
    const ok = await call("PATCH", `/api/tasks/${id}`, { allowedTools: ["Bash(plannotator:*)"] });
    expect(((await ok.json()) as any).task.allowedTools).toEqual(["Bash(plannotator:*)"]);
    for (const bad of [["-x"], ["a,b"], "Bash", [1], Array(51).fill("Read")])
      expect((await call("PATCH", `/api/tasks/${id}`, { allowedTools: bad })).status).toBe(400);
  });

  test("cannot archive while in progress", async () => {
    hold = true;
    const id = await create();
    await call("POST", `/api/tasks/${id}/start`);
    expect((await call("PATCH", `/api/tasks/${id}`, { status: "archived" })).status).toBe(409);
    release!();
    await runner.whenSettled(id);
  });
});
