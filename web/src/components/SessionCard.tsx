import { useEffect, useState } from "react";
import {
  fmtTokens,
  fmtUSD,
  modelShort,
  projectName,
  shortId,
  timeAgo,
  tsToMs,
} from "../lib/format";
import type { FleetSession, SessionStatus } from "../types";

const STATUS_LABEL: Record<SessionStatus, string> = {
  busy: "RUNNING",
  waiting: "AWAITING INPUT",
  idle: "IDLE",
  ended: "ENDED",
  missing: "SOURCE DELETED",
};

function TimeAgo({ sinceMs }: { sinceMs: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  if (!sinceMs) return null;
  return <span className="time-ago">{timeAgo(sinceMs)}</span>;
}

interface SessionCardProps {
  session: FleetSession;
  selected: boolean;
  onSelect: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}

export function SessionCard({
  session,
  selected,
  onSelect,
  onDismiss,
}: SessionCardProps) {
  const lastMs = Math.max(
    tsToMs(session.lastEventTs),
    session.statusUpdatedAt ?? 0,
  );
  const activity = session.lastActivity;
  const kindTag = session.kind === "bg" ? "BG" : session.pid ? "TUI" : "LOG";

  return (
    <article
      className={`card ${session.status} ${selected ? "selected" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Session ${projectName(session)}, ${STATUS_LABEL[session.status]}`}
      onClick={() => onSelect(session.sessionId)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(session.sessionId);
        }
      }}
    >
      <span className="corner tl" aria-hidden="true" />
      <span className="corner tr" aria-hidden="true" />
      <span className="corner bl" aria-hidden="true" />
      <span className="corner br" aria-hidden="true" />

      <header className="card-top mono">
        <span className={`status-dot ${session.status}`} aria-hidden="true" />
        <span className="status-label">{STATUS_LABEL[session.status]}</span>
        {session.status === "waiting" && session.waitingFor && (
          <span className="waiting-for">{session.waitingFor}</span>
        )}
        <span className="kind">{kindTag}</span>
        {session.status === "missing" && (
          <button
            type="button"
            className="card-dismiss mono"
            title="Retirer de la grille (aucune suppression sur disque)"
            aria-label="Retirer cette session de la grille"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss(session.sessionId);
            }}
          >
            ✕
          </button>
        )}
      </header>

      <h3 className="card-project">{projectName(session)}</h3>
      <div className="card-meta mono">
        {session.gitBranch && (
          <span className="branch">⎇ {session.gitBranch}</span>
        )}
        <span className="sid">#{shortId(session.sessionId)}</span>
        {session.models[0] && (
          <span className="model">{modelShort(session.models[0])}</span>
        )}
        {session.subAgents.length > 0 && (
          <span
            className="subagent-badge"
            title={`${session.subAgents.length} sous-agent(s) · ${fmtUSD(session.subAgentCostUSD)}`}
          >
            ⑃ {session.subAgents.length}
          </span>
        )}
      </div>

      {activity && (
        <div className="card-activity">
          <span className={`act-tag ${activity.kind}`}>{activity.label}</span>
          {activity.detail && (
            <span className="act-detail">{activity.detail}</span>
          )}
        </div>
      )}

      <footer className="card-stats mono">
        <span>
          {fmtTokens(session.usage.inputTokens + session.usage.outputTokens)}{" "}
          TOK
        </span>
        <span className="cost">{fmtUSD(session.costUSD)}</span>
        <TimeAgo sinceMs={lastMs} />
      </footer>
    </article>
  );
}
