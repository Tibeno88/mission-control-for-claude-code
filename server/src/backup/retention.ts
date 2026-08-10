import fsp from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";

interface ArchiveRow {
  id: number;
  archive_path: string;
}

/**
 * Deletes archives (DB rows + gz files) older than `retentionDays`, then
 * purges orphaned `session_snapshots` and `backup_runs` rows. A no-op when
 * `retentionDays <= 0` (infinite retention). File deletion is confined to
 * `backupDir` — paths outside it are never touched.
 */
export async function applyRetention(
  db: Database.Database,
  backupDir: string,
  retentionDays: number,
): Promise<void> {
  if (retentionDays <= 0) return;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const resolvedBackupDir = path.resolve(backupDir);

  const stale = db
    .prepare("SELECT id, archive_path FROM archives WHERE archived_at < ?")
    .all(cutoff) as ArchiveRow[];

  for (const row of stale) {
    const resolved = path.resolve(row.archive_path);
    if (resolved.startsWith(resolvedBackupDir + path.sep)) {
      try {
        await fsp.unlink(resolved);
      } catch {
        // already gone — fine, we still drop the DB row below
      }
    }
  }

  const deleteArchives = db.prepare(
    "DELETE FROM archives WHERE archived_at < ?",
  );
  // A run is purged once it is older than the cutoff AND all of its archives
  // have already aged out (no archive row still references it). This must run
  // AFTER deleteArchives so the just-pruned rows are already gone.
  const deleteOldRuns = db.prepare(
    `DELETE FROM backup_runs
     WHERE finished_at IS NOT NULL AND finished_at < ?
       AND id NOT IN (SELECT DISTINCT run_id FROM archives WHERE run_id IS NOT NULL)`,
  );
  // Snapshots whose run has just been removed become orphans — drop them last.
  const deleteOrphanSnapshots = db.prepare(
    `DELETE FROM session_snapshots
     WHERE run_id NOT IN (SELECT id FROM backup_runs)`,
  );

  db.transaction(() => {
    deleteArchives.run(cutoff);
    deleteOldRuns.run(cutoff);
    deleteOrphanSnapshots.run();
  })();
}
