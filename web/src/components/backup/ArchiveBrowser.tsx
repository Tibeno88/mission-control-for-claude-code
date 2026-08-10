import { useState } from "react";
import type { UseBackupState } from "../../lib/useBackup";
import type { ArchiveMeta } from "../../types";

interface ArchiveBrowserProps {
  backup: UseBackupState;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(2)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ArchiveList({ archives }: { archives: ArchiveMeta[] }) {
  if (archives.length === 0) {
    return (
      <p className="archive-list-empty mono">
        AUCUNE ARCHIVE POUR CETTE SESSION
      </p>
    );
  }
  return (
    <ul className="archive-meta-list mono">
      {archives.map((archive) => (
        <li
          key={archive.sessionId + archive.archivePath}
          className="archive-meta-row"
        >
          <span className="archive-meta-sha">
            {archive.sha256.slice(0, 10)}
          </span>
          <span className="archive-meta-size">{fmtBytes(archive.bytesGz)}</span>
          <span className="archive-meta-date">
            {fmtDate(archive.archivedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ArchiveBrowser({ backup }: ArchiveBrowserProps) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [archives, setArchives] = useState<Record<string, ArchiveMeta[]>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const recentSessions = backup.history?.byProject ?? [];

  const handleToggle = (projectSlug: string): void => {
    if (expanded === projectSlug) {
      setExpanded(null);
      return;
    }
    setExpanded(projectSlug);
    if (archives[projectSlug]) return;
    setLoadingId(projectSlug);
    void backup
      .getArchives(projectSlug)
      .then((result) => {
        setArchives((previous) => ({ ...previous, [projectSlug]: result }));
      })
      .catch(() => {
        setArchives((previous) => ({ ...previous, [projectSlug]: [] }));
      })
      .finally(() => setLoadingId(null));
  };

  return (
    <section className="archive-browser" aria-label="Navigateur d'archives">
      <h3 className="panel-title mono">ARCHIVES RÉCENTES</h3>
      <ul className="archive-browser-list">
        {recentSessions.map((project) => (
          <li key={project.projectSlug} className="archive-browser-row">
            <button
              type="button"
              className="archive-browser-toggle mono"
              onClick={() => handleToggle(project.projectSlug)}
              aria-expanded={expanded === project.projectSlug}
            >
              <span className="archive-toggle-caret" aria-hidden="true">
                {expanded === project.projectSlug ? "▾" : "▸"}
              </span>
              {project.displayName}
              <span className="archive-browser-count">
                {project.sessions} sess.
              </span>
            </button>
            {expanded === project.projectSlug && (
              <div className="archive-detail-panel">
                {loadingId === project.projectSlug ? (
                  <p className="archive-list-empty mono">CHARGEMENT…</p>
                ) : (
                  <ArchiveList archives={archives[project.projectSlug] ?? []} />
                )}
              </div>
            )}
          </li>
        ))}
        {recentSessions.length === 0 && (
          <li className="tile-list-empty mono">AUCUNE SESSION ARCHIVÉE</li>
        )}
      </ul>
    </section>
  );
}
