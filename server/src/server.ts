import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";
import { registerBackupRoutes } from "./backup/api.js";
import { openDb } from "./backup/db.js";
import { insertRequestEvent } from "./backup/request-events.js";
import { BackupScheduler } from "./backup/scheduler.js";
import { BackupService } from "./backup/service.js";
import type { BackupStatusEvent } from "./backup/types.js";
import { loadConfig } from "./config.js";
import { attachPlannotator, buildFleet, buildMetrics } from "./metrics.js";
import { PlannotatorRegistry } from "./plannotator.js";
import { PricingTable } from "./pricing.js";
import { LiveRegistry } from "./sessions.js";
import { TranscriptStore } from "./transcripts.js";

const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;
const HEARTBEAT_MS = 10_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function registerStaticUi(app: Hono): void {
  const webDist = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  if (!fs.existsSync(webDist)) return;

  app.get("*", async (c) => {
    const urlPath = decodeURIComponent(new URL(c.req.url).pathname);
    if (urlPath.startsWith("/api/")) return c.notFound();
    const relative = urlPath === "/" ? "index.html" : urlPath.slice(1);
    const resolved = path.resolve(webDist, relative);
    if (!resolved.startsWith(webDist + path.sep)) return c.notFound();

    let file = resolved;
    try {
      await fsp.access(file);
    } catch {
      file = path.join(webDist, "index.html"); // SPA fallback
    }
    const body = new Uint8Array(await fsp.readFile(file));
    const mime = MIME_TYPES[path.extname(file)] ?? "application/octet-stream";
    return c.body(body, 200, { "Content-Type": mime });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();

  const pricing = new PricingTable();
  void pricing.refreshFromLiteLLM().then((updated) => {
    if (updated > 0)
      console.log(`[pricing] refreshed ${updated} claude models from LiteLLM`);
  });

  // Opened before the store so the ingestion sink below can persist request
  // facts as transcripts are tailed, not only at backup time.
  const db = openDb(config.dbPath);

  const store = new TranscriptStore(
    config.projectsDir,
    pricing,
    Date.now() - config.scanDays * DAY_MS,
    (event) => insertRequestEvent(db, event),
  );
  await store.init();
  console.log(
    `[transcripts] tracking ${store.sessions().length} sessions (last ${config.scanDays} days)`,
  );

  const registry = new LiveRegistry(config.sessionsDir, config.registryPollMs);
  await registry.start();
  console.log(`[registry] ${registry.list().length} live sessions`);

  const plannotator = new PlannotatorRegistry(
    config.plannotatorSessionsDir,
    config.registryPollMs,
  );
  await plannotator.start();
  console.log(`[plannotator] ${plannotator.list().length} live sessions`);

  const backupService = new BackupService(db, store, config, pricing);
  const backupScheduler = new BackupScheduler(
    backupService,
    db,
    config.backupDir,
  );

  // Sessions manually removed from the grid (memory only — nothing touched on disk).
  const dismissed = new Set<string>();

  const snapshot = () => {
    const live = registry.list();
    // Full list (attached + unattached) drives the header counter; only the proven
    // ones are grafted onto their session card.
    const plannotatorSessions = plannotator.listAttributed(live);
    return {
      type: "snapshot" as const,
      fleet: attachPlannotator(
        buildFleet(live, store, dismissed),
        plannotatorSessions,
      ),
      metrics: buildMetrics(store),
      plannotator: plannotatorSessions,
      generatedAt: Date.now(),
    };
  };

  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/snapshot", (c) => c.json(snapshot()));
  app.get("/api/fleet", (c) =>
    c.json({
      sessions: buildFleet(registry.list(), store, dismissed),
      generatedAt: Date.now(),
    }),
  );
  app.get("/api/metrics", (c) => c.json(buildMetrics(store)));
  app.get("/api/plannotator", (c) =>
    c.json({
      sessions: plannotator.listAttributed(registry.list()),
      generatedAt: Date.now(),
    }),
  );
  app.get("/api/sessions/:id/activity", async (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id))
      return c.json({ error: "invalid session id" }, 400);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "80", 10);
    const limit = Number.isNaN(limitRaw)
      ? 80
      : Math.min(Math.max(limitRaw, 1), 300);
    const full = c.req.query("full") === "1";
    return c.json({ events: await store.recentActivity(id, limit, { full }) });
  });
  app.post("/api/sessions/:id/dismiss", (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id))
      return c.json({ error: "invalid session id" }, 400);
    if (registry.list().some((s) => s.sessionId === id))
      return c.json({ error: "session is live" }, 409);
    dismissed.add(id);
    scheduleBroadcast();
    return c.json({ ok: true });
  });
  registerBackupRoutes(app, {
    db,
    service: backupService,
    scheduler: backupScheduler,
    store,
    config,
  });
  registerStaticUi(app);

  const server = serve(
    { fetch: app.fetch, port: config.port, hostname: "127.0.0.1" },
    (info) => {
      console.log(
        `[server] Claude Mission Control on http://127.0.0.1:${info.port}`,
      );
    },
  );

  const wss = new WebSocketServer({
    server: server as HttpServer,
    path: "/ws",
  });
  const broadcast = (): void => {
    if (wss.clients.size === 0) return;
    const message = JSON.stringify(snapshot());
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  let pendingBroadcast: NodeJS.Timeout | undefined;
  const scheduleBroadcast = (): void => {
    if (pendingBroadcast) return;
    pendingBroadcast = setTimeout(() => {
      pendingBroadcast = undefined;
      broadcast();
    }, config.broadcastDebounceMs);
  };

  const broadcastBackupStatus = (evt: BackupStatusEvent): void => {
    if (wss.clients.size === 0) return;
    const message = JSON.stringify({
      type: "backup_status" as const,
      ...evt,
      generatedAt: Date.now(),
    });
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  };

  wss.on("connection", (ws) => ws.send(JSON.stringify(snapshot())));
  registry.on("change", scheduleBroadcast);
  plannotator.on("change", scheduleBroadcast);
  store.on("update", scheduleBroadcast);
  backupService.on("status", broadcastBackupStatus);
  // Heartbeat keeps relative timers and stale-PID detection fresh client-side.
  setInterval(broadcast, HEARTBEAT_MS).unref();

  backupScheduler.start();

  const shutdown = async (): Promise<void> => {
    clearTimeout(pendingBroadcast);
    wss.close();
    server.close();
    backupScheduler.stop();
    await Promise.all([registry.stop(), plannotator.stop(), store.stop()]);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((error) => {
  console.error("[server] fatal:", error);
  process.exit(1);
});
