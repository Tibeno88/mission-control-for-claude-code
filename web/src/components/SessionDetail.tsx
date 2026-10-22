import { useEffect, useState } from "react";
import {
  fmtEventTime,
  fmtTokens,
  fmtUSD,
  modelShort,
  projectName,
  timeAgo,
} from "../lib/format";
import type { ActivityEvent, FleetSession } from "../types";

const REFRESH_MS = 5000;

interface SessionDetailProps {
  session: FleetSession;
  onClose: () => void;
}

export function SessionDetail({ session, onClose }: SessionDetailProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let disposed = false;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/api/sessions/${session.sessionId}/activity?full=1`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as { events: ActivityEvent[] };
        if (!disposed) setEvents(data.events);
      } catch {
        // serveur momentanément injoignable : on garde le dernier état affiché
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [session.sessionId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const usage = session.usage;

  return (
    <aside
      className={expanded ? "detail detail-expanded" : "detail"}
      role="dialog"
      aria-label={`Détail de la session ${projectName(session)}`}
    >
      <header className="detail-head">
        <div className="detail-title">
          <span className={`status-dot ${session.status}`} aria-hidden="true" />
          <h2>{projectName(session)}</h2>
        </div>
        <div className="detail-actions">
          <button
            type="button"
            className="detail-expand mono"
            aria-pressed={expanded}
            aria-label="Vue élargie"
            title="Vue élargie"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "⤡" : "⤢"}
          </button>
          <button
            type="button"
            className="detail-close mono"
            onClick={onClose}
            aria-label="Fermer le panneau"
          >
            ✕
          </button>
        </div>
      </header>
      <p className="detail-sid mono">{session.sessionId}</p>

      <dl className="detail-meta mono">
        {session.name?.trim() && (
          <div className="meta-row">
            <dt>TITLE</dt>
            <dd className="wrap">{session.name}</dd>
          </div>
        )}
        {session.pid !== undefined && (
          <div className="meta-row">
            <dt>PID</dt>
            <dd>{session.pid}</dd>
          </div>
        )}
        {session.kind && (
          <div className="meta-row">
            <dt>KIND</dt>
            <dd>{session.kind}</dd>
          </div>
        )}
        {session.gitBranch && (
          <div className="meta-row">
            <dt>BRANCH</dt>
            <dd>{session.gitBranch}</dd>
          </div>
        )}
        {session.cwd && (
          <div className="meta-row">
            <dt>CWD</dt>
            <dd className="wrap">{session.cwd}</dd>
          </div>
        )}
        <div className="meta-row">
          <dt>MODELS</dt>
          <dd>{session.models.map(modelShort).join(", ") || "—"}</dd>
        </div>
        <div className="meta-row">
          <dt>PROMPTS</dt>
          <dd>{session.prompts}</dd>
        </div>
        {session.startedAt !== undefined && (
          <div className="meta-row">
            <dt>UPTIME</dt>
            <dd>{timeAgo(session.startedAt)}</dd>
          </div>
        )}
      </dl>

      <div className="detail-usage">
        <div className="usage-row">
          <span>INPUT</span>
          <span className="mono">{fmtTokens(usage.inputTokens)}</span>
        </div>
        <div className="usage-row">
          <span>OUTPUT</span>
          <span className="mono">{fmtTokens(usage.outputTokens)}</span>
        </div>
        <div className="usage-row">
          <span>CACHE READ</span>
          <span className="mono">{fmtTokens(usage.cacheReadTokens)}</span>
        </div>
        <div className="usage-row">
          <span>CACHE WRITE</span>
          <span className="mono">
            {fmtTokens(usage.cacheWrite5mTokens + usage.cacheWrite1hTokens)}
          </span>
        </div>
        <div className="usage-row total">
          <span>EST. COST</span>
          <span className="mono">{fmtUSD(session.costUSD)}</span>
        </div>
        {session.subAgentCostUSD > 0 && (
          <div className="usage-row subagent">
            <span>↳ SUB-AGENTS</span>
            <span className="mono">{fmtUSD(session.subAgentCostUSD)}</span>
          </div>
        )}
      </div>

      {session.subAgents.length > 0 && (
        <>
          <h3 className="detail-feed-title">
            SUB-AGENTS{" "}
            <span className="count-badge">{session.subAgents.length}</span>
          </h3>
          <ul className="subagent-list">
            {[...session.subAgents]
              .sort((a, b) => b.costUSD - a.costUSD)
              .map((sub) => (
                <li key={sub.agentId} className="subagent-item">
                  <div className="subagent-head mono">
                    <span className="subagent-type">{sub.type ?? "agent"}</span>
                    <span className="subagent-model">
                      {sub.models.map(modelShort).join(", ") || "—"}
                    </span>
                    <span className="subagent-cost">{fmtUSD(sub.costUSD)}</span>
                  </div>
                  <div className="subagent-usage mono">
                    {fmtTokens(sub.usage.inputTokens + sub.usage.outputTokens)}{" "}
                    TOK
                    {sub.firstTs && (
                      <span className="subagent-time">
                        {" · "}
                        {fmtEventTime(sub.firstTs)}
                      </span>
                    )}
                  </div>
                  {sub.taskPrompt && (
                    <p className="subagent-task">{sub.taskPrompt}</p>
                  )}
                </li>
              ))}
          </ul>
        </>
      )}

      <h3 className="detail-feed-title">ACTIVITY FEED</h3>
      <ol className="detail-feed">
        {[...events].reverse().map((event, index) => (
          <li
            key={`${event.ts}-${index}`}
            className={`feed-item ${event.kind}`}
          >
            <span className="feed-ts mono">{fmtEventTime(event.ts)}</span>
            <span className={`act-tag ${event.kind}`}>{event.label}</span>
            {event.detail && (
              <span className="feed-detail">{event.detail}</span>
            )}
          </li>
        ))}
        {events.length === 0 && (
          <li className="feed-empty mono">NO ACTIVITY PARSED</li>
        )}
      </ol>
    </aside>
  );
}
