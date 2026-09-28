import { useEffect } from "react";
import { useBackup } from "../../lib/useBackup";
import { AccountManager } from "./AccountManager";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { BackupPanel } from "./BackupPanel";

/**
 * CONFIG view: backup scheduling, accounts and archive browsing only.
 * Consumption metrics live in the DASHBOARD view.
 */
export function ArchiveView() {
  const backup = useBackup();

  useEffect(() => {
    // "all": the archive browser lists every archived project, unfiltered.
    void backup.loadAll("all", null, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="archive-view">
      {backup.lastError && (
        <div className="archive-error mono" role="alert">
          ERREUR // {backup.lastError}
        </div>
      )}

      <div className="archive-grid">
        <div className="archive-col">
          <BackupPanel backup={backup} />
          <ArchiveBrowser backup={backup} />
        </div>
        <div className="archive-col">
          <AccountManager backup={backup} />
        </div>
      </div>
    </div>
  );
}
