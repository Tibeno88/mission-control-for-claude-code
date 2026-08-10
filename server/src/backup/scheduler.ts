import type Database from "better-sqlite3";
import cron, { type ScheduledTask } from "node-cron";
import { getBackupConfig } from "./db.js";
import type { BackupService } from "./service.js";

/**
 * Schedules `service.run("scheduled")` per the current `backup_config` cron
 * expression. Reload after any config write to pick up new settings.
 */
export class BackupScheduler {
  private task: ScheduledTask | undefined;

  constructor(
    private readonly service: BackupService,
    private readonly db: Database.Database,
    private readonly fallbackBackupDir: string,
  ) {}

  start(): void {
    const config = getBackupConfig(this.db, this.fallbackBackupDir);
    if (!config.enabled) return;
    this.schedule(config.cron);
  }

  /** Destroys the existing cron task (if any) and reprograms from current config. */
  reload(): void {
    this.task?.stop();
    this.task = undefined;

    const config = getBackupConfig(this.db, this.fallbackBackupDir);
    if (!config.enabled) return;
    this.schedule(config.cron);
  }

  stop(): void {
    this.task?.stop();
    this.task = undefined;
  }

  private schedule(expression: string): void {
    if (!cron.validate(expression)) {
      throw new Error(`invalid cron expression: "${expression}"`);
    }
    this.task = cron.schedule(expression, () => {
      // The service's own mutex prevents overlap with a concurrent run.
      void this.service.run("scheduled").catch((error: unknown) => {
        console.warn(
          "[backup] scheduled run failed:",
          error instanceof Error ? error.message : error,
        );
      });
    });
  }
}
