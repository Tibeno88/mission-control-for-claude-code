import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { localRequestError, localRequestGuard } from "../src/local-guard.js";

describe("localRequestError", () => {
  test.each([
    ["127.0.0.1:4517", undefined],
    ["localhost:5173", "http://localhost:5173"],
    ["127.0.0.1:4517", "http://127.0.0.1:4517"],
    ["localhost", undefined],
  ])("allows local Host %s with Origin %s", (host, origin) => {
    expect(localRequestError(host, origin)).toBeNull();
  });

  test.each([
    ["missing Host", undefined, undefined],
    ["foreign Host", "evil.example:4517", undefined],
    [
      "Host hostname smuggling a local-looking suffix",
      "127.0.0.1.evil.example",
      undefined,
    ],
    [
      "Host hostname prefixed with localhost",
      "localhost.evil.example:4517",
      undefined,
    ],
    ["foreign Host with foreign Origin", "evil.example", "http://evil.example"],
  ])("refuses %s as forbidden host", (_name, host, origin) => {
    expect(localRequestError(host, origin)).toBe("forbidden host");
  });

  test.each([
    ["foreign Origin", "127.0.0.1:4517", "http://evil.example"],
    ["sandboxed or file:// Origin 'null'", "127.0.0.1:4517", "null"],
    [
      "Origin hostname differing from Host",
      "127.0.0.1:4517",
      "http://localhost:4517",
    ],
    [
      "Origin port differing from Host",
      "localhost:4517",
      "http://localhost:9999",
    ],
    ["unparseable Origin", "127.0.0.1:4517", "not a url"],
  ])("refuses %s as forbidden origin", (_name, host, origin) => {
    expect(localRequestError(host, origin)).toBe("forbidden origin");
  });
});

describe("localRequestGuard", () => {
  const app = new Hono();
  app.use("/api/*", localRequestGuard);
  app.get("/api/x", (c) => c.json({ ok: true }));
  app.put("/api/x", (c) => c.json({ ok: true }));
  app.get("/", (c) => c.text("ui"));

  test("lets a local GET on an API route through", async () => {
    const res = await app.request("/api/x", {
      headers: { host: "127.0.0.1:4517" },
    });
    expect(res.status).toBe(200);
  });

  test("blocks an API read under a rebinding Host with 403 forbidden host", async () => {
    const res = await app.request("/api/x", {
      headers: { host: "evil.example:4517" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden host" });
  });

  test("blocks a cross-origin PUT with 403 forbidden origin", async () => {
    const res = await app.request("/api/x", {
      method: "PUT",
      headers: { host: "127.0.0.1:4517", origin: "http://evil.example" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden origin" });
  });

  test("does not guard non-API routes", async () => {
    const res = await app.request("/", { headers: { host: "evil.example" } });
    expect(res.status).toBe(200);
  });
});
