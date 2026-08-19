import { useEffect, useRef, useState } from "react";
import { timeAgo } from "../lib/format";
import type { PlannotatorSessionInfo } from "../types";

/** Closes the panel on outside click or Escape while it is open. */
function useDismiss(
  open: boolean,
  close: () => void,
): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return ref;
}

interface PlannotatorListProps {
  sessions: PlannotatorSessionInfo[];
}

/** Shared rows — the header dropdown and the card popover render the same list. */
export function PlannotatorList({ sessions }: PlannotatorListProps) {
  if (sessions.length === 0) {
    return <p className="plan-empty mono">AUCUNE SESSION PLANNOTATOR</p>;
  }

  return (
    <ul className="plan-list">
      {sessions.map((session) => (
        <li className="plan-row" key={session.pid}>
          <div className="plan-row-top mono">
            <span className="plan-mode">{session.mode}</span>
            <span className="plan-label">
              {session.label ?? session.project}
            </span>
            {session.startedAt > 0 && (
              <span className="plan-age">{timeAgo(session.startedAt)}</span>
            )}
          </div>
          <a
            className="plan-url mono"
            href={session.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
          >
            {session.url}
          </a>
          {!session.claudeSessionId && (
            <span
              className="plan-orphan mono"
              title="Aucune session Claude parente identifiée"
            >
              NON RATTACHÉE
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface PlannotatorIndicatorProps {
  sessions: PlannotatorSessionInfo[];
}

/** Header counter — highlighted as soon as at least one Plannotator UI is up. */
export function PlannotatorIndicator({ sessions }: PlannotatorIndicatorProps) {
  const [open, setOpen] = useState(false);
  const count = sessions.length;
  const ref = useDismiss(open, () => setOpen(false));

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  return (
    <div className="plan-indicator" ref={ref}>
      <button
        type="button"
        className={`count plan-count ${count > 0 ? "alert" : ""}`}
        disabled={count === 0}
        aria-expanded={open}
        aria-label={`${count} session(s) Plannotator active(s)`}
        title="Sessions Plannotator ouvertes"
        onClick={() => setOpen((current) => !current)}
      >
        ⌸ {count} PLAN
      </button>
      {open && (
        <div
          className="plan-dropdown"
          role="dialog"
          aria-label="Sessions Plannotator"
        >
          <PlannotatorList sessions={sessions} />
        </div>
      )}
    </div>
  );
}

interface PlannotatorBadgeProps {
  sessions: PlannotatorSessionInfo[];
}

/**
 * Card badge. Clicks are swallowed so opening the popover never also opens the
 * session detail panel behind it.
 */
export function PlannotatorBadge({ sessions }: PlannotatorBadgeProps) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));

  return (
    <div
      className="plan-anchor"
      ref={ref}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      role="presentation"
    >
      <button
        type="button"
        className={`plan-badge ${sessions.length > 0 ? "active" : ""} ${open ? "open" : ""}`}
        aria-expanded={open}
        aria-label={`${sessions.length} session(s) Plannotator sur cette session Claude`}
        title="Sessions Plannotator de cette session Claude"
        onClick={() => setOpen((current) => !current)}
      >
        ⌸ {sessions.length}
      </button>
      {open && (
        <div
          className="plan-popover"
          role="dialog"
          aria-label="Sessions Plannotator"
        >
          <PlannotatorList sessions={sessions} />
        </div>
      )}
    </div>
  );
}
