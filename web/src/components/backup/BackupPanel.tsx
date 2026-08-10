import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { UseBackupState } from "../../lib/useBackup";
import type { BackupRun } from "../../types";

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtDate(ms: number): string {
  const date = new Date(ms);
  return date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const CRON_PRESETS: Array<{ label: string; value: string }> = [
  { label: "TOUTES LES HEURES", value: "0 * * * *" },
  { label: "TOUTES LES 6H", value: "0 */6 * * *" },
  { label: "CHAQUE NUIT 3H", value: "0 3 * * *" },
];

interface BackupPanelProps {
  backup: UseBackupState;
}

function LastRunSummary({ run }: { run: BackupRun }) {
  return (
    <dl className="run-summary mono">
      <div className="run-row">
        <dt>DATE</dt>
        <dd>{fmtDate(run.startedAt)}</dd>
      </div>
      <div className="run-row">
        <dt>SESSIONS</dt>
        <dd>{run.sessionsCount}</dd>
      </div>
      <div className="run-row">
        <dt>FICHIERS</dt>
        <dd>{run.filesArchived}</dd>
      </div>
      <div className="run-row">
        <dt>TAILLE</dt>
        <dd>
          {fmtBytes(run.bytesRaw)} → {fmtBytes(run.bytesGz)}
        </dd>
      </div>
      {run.error && (
        <div className="run-row error">
          <dt>ERREUR</dt>
          <dd>{run.error}</dd>
        </div>
      )}
    </dl>
  );
}

export function BackupPanel({ backup }: BackupPanelProps) {
  const [cron, setCron] = useState("0 3 * * *");
  const [enabled, setEnabled] = useState(false);
  const [retentionDays, setRetentionDays] = useState(30);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    if (!backup.config) return;
    setCron(backup.config.cron);
    setEnabled(backup.config.enabled);
    setRetentionDays(backup.config.retentionDays);
  }, [backup.config]);

  const lastRun = backup.runs[0] ?? null;
  const running = backup.backupStatus === "running";

  const handleRun = (): void => {
    void backup.runBackup().catch(() => undefined);
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void backup
      .putConfig({ enabled, cron, retentionDays })
      .then(() => {
        setSavedNotice(true);
        setTimeout(() => setSavedNotice(false), 2500);
      })
      .catch(() => undefined);
  };

  return (
    <section className="backup-panel" aria-label="Sauvegarde">
      <header className="panel-head mono">
        <span className="panel-title">ARCHIVAGE</span>
        <span className={`backup-status ${backup.backupStatus}`}>
          {backup.backupStatus.toUpperCase()}
        </span>
      </header>

      <button
        type="button"
        className={`backup-run-btn ${running ? "running" : ""}`}
        onClick={handleRun}
        disabled={running}
        aria-busy={running}
      >
        <span className="reactor-ring" aria-hidden="true">
          <svg viewBox="0 0 40 40" width="22" height="22">
            <circle
              cx="20"
              cy="20"
              r="16"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.3"
              strokeWidth="2"
            />
            <circle
              className="reactor-ring-arc"
              cx="20"
              cy="20"
              r="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray="30 70"
            />
          </svg>
        </span>
        {running ? "SAUVEGARDE EN COURS…" : "LANCER SAUVEGARDE"}
      </button>

      {lastRun ? (
        <LastRunSummary run={lastRun} />
      ) : (
        <p className="run-empty mono">AUCUNE SAUVEGARDE ENREGISTRÉE</p>
      )}

      <form className="schedule-form" onSubmit={handleSubmit}>
        <h3 className="form-title mono">PLANIFICATION</h3>
        <label className="form-toggle mono">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          <span>ACTIVER LA PLANIFICATION</span>
        </label>

        <div className="cron-presets mono">
          {CRON_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              className={`preset-btn ${cron === preset.value ? "active" : ""}`}
              onClick={() => setCron(preset.value)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <label className="form-field mono">
          <span>CRON</span>
          <input
            type="text"
            value={cron}
            onChange={(event) => setCron(event.target.value)}
            className="mono"
            aria-label="Expression cron"
          />
        </label>

        <label className="form-field mono">
          <span>RÉTENTION (JOURS)</span>
          <input
            type="number"
            min={1}
            value={retentionDays}
            onChange={(event) => setRetentionDays(Number(event.target.value))}
            className="mono"
          />
        </label>

        <button type="submit" className="form-submit mono">
          ENREGISTRER
        </button>
        {savedNotice && (
          <span className="form-saved mono">CONFIGURATION ENREGISTRÉE</span>
        )}
      </form>
    </section>
  );
}
