import { useState, type CSSProperties } from "react";
import type { Task, TaskStatus } from "../../types";
import { TaskForm } from "./TaskForm";
import { TaskTile } from "./TaskTile";

const COLUMNS: Array<{ status: TaskStatus; label: string }> = [
  { status: "todo", label: "TODO" },
  { status: "in_progress", label: "IN PROGRESS" },
  { status: "waiting", label: "WAITING" },
  { status: "done", label: "DONE" },
];

interface TaskBoardProps {
  tasks: Task[];
  liveSessionIds: ReadonlySet<string>;
  onOpenSession: (sessionId: string) => void;
}

export function TaskBoard({
  tasks,
  liveSessionIds,
  onOpenSession,
}: TaskBoardProps) {
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = tasks.filter((t) => t.status === "archived").length;
  const waiting = tasks.filter((t) => t.status === "waiting").length;
  const columns = showArchived
    ? [...COLUMNS, { status: "archived" as const, label: "ARCHIVED" }]
    : COLUMNS;

  return (
    <div className="task-board">
      <TaskForm />
      <div className="task-toolbar mono">
        <span aria-live="polite">
          {waiting > 0
            ? `${waiting} EN ATTENTE DE VOTRE RÉPONSE`
            : "AUCUNE RÉPONSE ATTENDUE"}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />{" "}
          AFFICHER ARCHIVÉES ({archivedCount})
        </label>
      </div>
      <div
        className="task-columns"
        style={{ "--cols": columns.length } as CSSProperties}
      >
        {columns.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section
              key={col.status}
              className={`task-col ${col.status}`}
              aria-label={col.label}
            >
              <h2 className="task-col-title mono">
                {col.label} <span className="task-count">{items.length}</span>
              </h2>
              <div className="task-col-body" aria-live="polite">
                {items.map((task) => (
                  <TaskTile
                    key={task.id}
                    task={task}
                    canOpenSession={
                      !!task.sessionId && liveSessionIds.has(task.sessionId)
                    }
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
