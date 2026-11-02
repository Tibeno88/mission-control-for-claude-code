import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { fmtUSD, timeAgo } from "../../lib/format";
import { isSubmitShortcut } from "../../lib/shortcuts";
import { taskRequest } from "../../lib/tasksApi";
import { MODES } from "./TaskForm";
import type { Task } from "../../types";

// Markdown libs load only when a modal with a response opens.
const Markdown = lazy(() =>
  import("./Markdown").then((m) => ({ default: m.Markdown })),
);

interface TaskTileProps {
  task: Task;
  canOpenSession: boolean;
  onOpenSession: (sessionId: string) => void;
}

const LABEL: Record<Task["status"], string> = {
  todo: "TODO",
  in_progress: "IN PROGRESS",
  waiting: "WAITING — À VOTRE TOUR",
  done: "DONE",
  archived: "ARCHIVED",
};

export function TaskTile({
  task,
  canOpenSession,
  onOpenSession,
}: TaskTileProps) {
  const [reply, setReply] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [mode, setMode] = useState(task.permissionMode);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Native <dialog>: focus trap and Escape come for free.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (expanded && dialog && !dialog.open) dialog.showModal();
  }, [expanded]);

  const act = async (
    method: "POST" | "PATCH",
    path: string,
    body?: unknown,
  ): Promise<boolean> => {
    const err = await taskRequest(method, `/${task.id}${path}`, body);
    setError(err);
    return err === null;
  };
  const patch = (status: string): void => void act("PATCH", "", { status });
  const send = async (): Promise<void> => {
    if (!reply.trim()) return;
    // Mode change (ex. plan -> auto) applies to the resumed run.
    if (
      mode !== task.permissionMode &&
      !(await act("PATCH", "", { permissionMode: mode }))
    )
      return;
    if (await act("POST", "/reply", { message: reply })) {
      setReply("");
      dialogRef.current?.close();
    }
  };
  const allowAndResume = async (): Promise<void> => {
    const tools = [
      ...new Set([...(task.allowedTools ?? []), ...task.deniedTools]),
    ];
    if (await act("PATCH", "", { allowedTools: tools }))
      await act("POST", "/reply", { message: "continue" });
  };
  const shown = error ?? task.error;
  const canRelaunch = task.status === "waiting" && !task.sessionId;

  return (
    <article
      className={`task-tile ${task.status}`}
      aria-label={`${task.title}, ${LABEL[task.status]}`}
    >
      <header className="task-tile-head mono">
        <span className="task-state">
          {task.status === "in_progress" && (
            <span className="task-spinner" aria-hidden="true" />
          )}
          {LABEL[task.status]}
          {task.plannotatorUrl && (
            <>
              {" · "}
              <a
                href={task.plannotatorUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                PLANNOTATOR
              </a>
            </>
          )}
        </span>
        <span className="task-meta">
          {task.costUsd !== null && `${fmtUSD(task.costUsd)} · `}
          {timeAgo(task.updatedAt)}
          <button
            type="button"
            className={`task-btn task-expand${task.status === "waiting" ? " attention" : ""}`}
            aria-label="Ouvrir le détail de la tâche"
            title="Détail / réponse"
            onClick={() => setExpanded(true)}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M9 2h5v5M7 14H2V9M14 2 9.5 6.5M2 14l4.5-4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        </span>
      </header>
      <dialog
        ref={dialogRef}
        className="task-modal"
        aria-label={`Détail : ${task.title}`}
        onClose={() => setExpanded(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        {expanded && (
          <>
            <header className="task-modal-head mono">
              <span>
                {LABEL[task.status]} · {task.cwd}
              </span>
              <button
                type="button"
                className="task-btn"
                onClick={() => dialogRef.current?.close()}
              >
                FERMER (Échap)
              </button>
            </header>
            <div className="task-modal-body">
              <h3 className="task-title">{task.title}</h3>
              <pre
                className="task-result"
                tabIndex={0}
                aria-label="Description"
              >
                {task.prompt}
              </pre>
              {task.lastResult && (
                <div
                  className="task-result markdown"
                  tabIndex={0}
                  aria-label="Dernière réponse de Claude"
                >
                  <Suspense fallback={task.lastResult}>
                    <Markdown>{task.lastResult}</Markdown>
                  </Suspense>
                </div>
              )}
              {shown && (
                <p className="task-error mono" role="alert">
                  {shown}
                </p>
              )}
            </div>
            {task.status === "waiting" &&
              task.sessionId &&
              task.deniedTools.length > 0 && (
                <div className="task-denied">
                  <span className="mono">
                    OUTILS REFUSÉS : {task.deniedTools.join(", ")}
                  </span>
                  <button
                    type="button"
                    className="task-btn"
                    onClick={() => void allowAndResume()}
                  >
                    AUTORISER + RELANCER
                  </button>
                </div>
              )}
            {task.status === "waiting" && task.sessionId && (
              <div className="task-reply task-modal-reply">
                <label>
                  <span className="mono">VOTRE RÉPONSE</span>
                  <textarea
                    value={reply}
                    rows={6}
                    maxLength={20000}
                    autoFocus
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => {
                      if (isSubmitShortcut(e)) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                </label>
                <label>
                  <span className="mono">MODE</span>
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    {MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="task-btn primary"
                  disabled={!reply.trim()}
                  onClick={() => void send()}
                >
                  ENVOYER (Ctrl+Entrée)
                </button>
              </div>
            )}
          </>
        )}
      </dialog>
      <h3 className="task-title">{task.title}</h3>
      <p className="task-prompt" title={task.prompt}>
        {task.prompt}
      </p>
      <p className="task-cwd mono">{task.cwd}</p>

      {shown && (
        <p className="task-error mono" role="alert">
          {shown}
        </p>
      )}

      <footer className="task-actions">
        {(task.status === "todo" || canRelaunch) && (
          <button
            type="button"
            className="task-btn primary"
            onClick={() => void act("POST", "/start")}
          >
            {canRelaunch ? "RELANCER" : "START"}
          </button>
        )}
        {task.status === "waiting" && (
          <button
            type="button"
            className="task-btn"
            onClick={() => patch("done")}
          >
            MARK DONE
          </button>
        )}
        {task.sessionId && canOpenSession && (
          <button
            type="button"
            className="task-btn"
            onClick={() => onOpenSession(task.sessionId as string)}
          >
            VOIR LA SESSION
          </button>
        )}
        {task.status === "archived" ? (
          <button
            type="button"
            className="task-btn"
            onClick={() => patch("todo")}
          >
            RESTORE
          </button>
        ) : (
          task.status !== "in_progress" && (
            <button
              type="button"
              className="task-btn"
              onClick={() => patch("archived")}
            >
              ARCHIVE
            </button>
          )
        )}
      </footer>
    </article>
  );
}
