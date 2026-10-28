import { useState } from "react";
import { fmtUSD, timeAgo } from "../../lib/format";
import { taskRequest } from "../../lib/tasksApi";
import type { Task } from "../../types";

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
    if (reply.trim() && (await act("POST", "/reply", { message: reply })))
      setReply("");
  };
  const allowAndResume = async (): Promise<void> => {
    const tools = [...new Set([...(task.allowedTools ?? []), ...task.deniedTools])];
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
        </span>
        <span className="task-meta">
          {task.costUsd !== null && `${fmtUSD(task.costUsd)} · `}
          {timeAgo(task.updatedAt)}
        </span>
      </header>
      <h3 className="task-title">{task.title}</h3>
      <p className="task-prompt" title={task.prompt}>
        {task.prompt}
      </p>
      <p className="task-cwd mono">{task.cwd}</p>

      {task.lastResult && (
        <pre
          className="task-result"
          tabIndex={0}
          aria-label="Dernière réponse de Claude"
        >
          {task.lastResult}
        </pre>
      )}
      {shown && (
        <p className="task-error mono" role="alert">
          {shown}
        </p>
      )}

      {task.status === "waiting" && task.sessionId && task.deniedTools.length > 0 && (
        <div className="task-denied">
          <span className="mono">OUTILS REFUSÉS : {task.deniedTools.join(", ")}</span>
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
        <div className="task-reply">
          <label>
            <span className="mono">VOTRE RÉPONSE</span>
            <textarea
              value={reply}
              rows={3}
              maxLength={20000}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
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
