import { useEffect, useState } from "react";
import { useBackup } from "../../lib/useBackup";
import type { HistoryPeriod } from "../../types";
import { AccountManager } from "./AccountManager";
import { ArchiveBrowser } from "./ArchiveBrowser";
import { BackupPanel } from "./BackupPanel";
import { HistoryView } from "./HistoryView";

const PERIODS: Array<{ value: HistoryPeriod; label: string }> = [
  { value: "today", label: "AUJOURD'HUI" },
  { value: "7d", label: "7 JOURS" },
  { value: "30d", label: "30 JOURS" },
  { value: "all", label: "TOUT" },
];

export function ArchiveView() {
  const backup = useBackup();
  const [period, setPeriod] = useState<HistoryPeriod>("today");
  const [accountFilter, setAccountFilter] = useState<number | null>(null);

  useEffect(() => {
    void backup.loadAll(period, accountFilter, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, accountFilter]);

  return (
    <div className="archive-view">
      <section className="archive-toolbar" aria-label="Filtres de l'historique">
        <div className="period-select mono" role="tablist" aria-label="Période">
          {PERIODS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              aria-selected={period === entry.value}
              className={`period-btn ${period === entry.value ? "active" : ""}`}
              onClick={() => setPeriod(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label className="account-filter mono">
          <span>COMPTE</span>
          <select
            value={accountFilter ?? ""}
            onChange={(event) =>
              setAccountFilter(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
          >
            <option value="">TOUS</option>
            {backup.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      {backup.lastError && (
        <div className="archive-error mono" role="alert">
          ERREUR // {backup.lastError}
        </div>
      )}

      <div className="archive-grid">
        <div className="archive-col">
          <BackupPanel backup={backup} />
          <HistoryView history={backup.history} loading={backup.loading} />
        </div>
        <div className="archive-col">
          <AccountManager backup={backup} />
          <ArchiveBrowser backup={backup} />
        </div>
      </div>
    </div>
  );
}
