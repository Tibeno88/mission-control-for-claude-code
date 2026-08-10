#!/usr/bin/env node
import { loadConfig } from "../config.js";
import { PricingTable } from "../pricing.js";
import { TranscriptStore } from "../transcripts.js";
import { openDb, getBackupConfig } from "./db.js";
import { BackupService } from "./service.js";
import type { BackupRun } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function printSummary(run: BackupRun): void {
  const durationMs =
    run.finishedAt !== null ? run.finishedAt - run.startedAt : 0;
  console.log("");
  console.log("Backup run summary");
  console.log("-------------------");
  console.log(`  run id:          ${run.id}`);
  console.log(`  mode:             ${run.mode}`);
  console.log(`  sessions:         ${run.sessionsCount}`);
  console.log(`  files archived:   ${run.filesArchived}`);
  console.log(
    `  size (raw → gz):  ${formatBytes(run.bytesRaw)} → ${formatBytes(run.bytesGz)}`,
  );
  console.log(`  duration:         ${(durationMs / 1000).toFixed(2)}s`);
  if (run.error) console.log(`  error:            ${run.error}`);
  console.log("");
}

async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDb(config.dbPath);
  const pricing = new PricingTable();
  const store = new TranscriptStore(
    config.projectsDir,
    pricing,
    Date.now() - config.scanDays * DAY_MS,
  );

  try {
    await store.init();
    // Ensure the row exists / defaults are seeded; the value itself isn't
    // needed here since BackupService re-reads it internally.
    getBackupConfig(db, config.backupDir);

    const service = new BackupService(db, store, config);
    console.log(
      `[backup] starting manual run (sessions tracked: ${store.sessions().length})`,
    );
    const run = await service.run("manual");
    printSummary(run);

    await store.stop();
    db.close();
    process.exit(run.error ? 1 : 0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[backup] run failed: ${message}`);
    try {
      await store.stop();
    } catch {
      // best-effort cleanup, ignore secondary failures
    }
    try {
      db.close();
    } catch {
      // best-effort cleanup, ignore secondary failures
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[backup] unexpected error: ${message}`);
  process.exit(1);
});
