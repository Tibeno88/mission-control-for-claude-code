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
import { PlannotatorBadge } from "./PlannotatorPanel";

const STATUS_LABEL: Record<SessionStatus, string> = {
  busy: "RUNNING",
  waiting: "AWAITING INPUT",
  idle: "READY",
  ended: "ENDED",
  missing: "SOURCE DELETED",
};

function TimeAgo({ sinceMs, bare }: { sinceMs: number; bare?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  if (!sinceMs) return null;
  return (
    <span className={bare ? "busy-since" : "time-ago"}>{timeAgo(sinceMs)}</span>
  );
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
  // Le titre ne vient que du registre live : les sessions terminées n'en ont plus.
  const title = session.name?.trim() ?? "";
  const project = projectName(session);

  return (
    <article
      className={`card ${session.status} ${selected ? "selected" : ""}`}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      aria-label={`Session ${project}${title ? ` — ${title}` : ""}, ${STATUS_LABEL[session.status]}`}
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
        {session.status === "busy" && session.statusUpdatedAt && (
          <TimeAgo sinceMs={session.statusUpdatedAt} bare />
        )}
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

      <h3 className="card-project">{project}</h3>
      {title && (
        <p
          className={`card-title${session.nameSource === "derived" ? " derived" : ""}`}
          title={title}
        >
          {title}
        </p>
      )}
      <div className="card-meta mono">
        {session.gitBranch && (
          <span className="branch">⎇ {session.gitBranch}</span>
        )}
        {session.headless && (
          <span
            className="headless-badge"
            title="Session non interactive (claude -p) — reprise : claude -p --resume <id> «…»"
          >
            -P
          </span>
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
            {(() => {
              const parentModel = session.models[0] ?? "";
              const subModels = [
                ...new Set(session.subAgents.flatMap((s) => s.models)),
              ].filter((m) => m !== parentModel);
              return subModels.length > 0
                ? ` · ${subModels.map(modelShort).join(", ")}`
                : null;
            })()}
          </span>
        )}
        {session.plannotator && session.plannotator.length > 0 && (
          <PlannotatorBadge sessions={session.plannotator} />
        )}
      </div>

      {session.recap && session.status !== "busy" && (
        <p className="card-recap" title={session.recap.text}>
          <span className="recap-tag mono">
            {session.status === "waiting" ? "RECAP" : "DONE"}
          </span>
          {session.recap.text}
        </p>
      )}

      {activity && (session.status === "busy" || !session.recap) && (
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
