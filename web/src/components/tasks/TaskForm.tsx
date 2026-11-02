import { useState, type FormEvent } from "react";
import { isSubmitShortcut } from "../../lib/shortcuts";
import { taskRequest } from "../../lib/tasksApi";

export const MODES = [
  { value: "manual", label: "manual (demande)" },
  { value: "acceptEdits", label: "acceptEdits" },
  { value: "auto", label: "auto" },
  { value: "plan", label: "plan (lecture seule)" },
];

interface TaskFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

export function TaskForm({ onCreated, onCancel }: TaskFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const model = String(data.get("model") ?? "").trim();
    const tools = String(data.get("allowedTools") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setBusy(true);
    const err = await taskRequest("POST", "", {
      title: data.get("title"),
      prompt: data.get("prompt"),
      cwd: String(data.get("cwd") ?? "").trim(),
      permissionMode: data.get("permissionMode"),
      ...(model ? { model } : {}),
      ...(tools.length ? { allowedTools: tools } : {}),
    });
    setBusy(false);
    setError(err);
    if (!err) onCreated();
  };

  return (
    <form className="task-form" onSubmit={(e) => void submit(e)}>
      <label>
        <span className="mono">TITRE</span>
        <input name="title" required maxLength={200} autoFocus />
      </label>
      <label>
        <span className="mono">RÉPERTOIRE (chemin absolu)</span>
        <input name="cwd" required placeholder="/home/…/projet" />
      </label>
      <label>
        <span className="mono">MODÈLE (optionnel)</span>
        <input name="model" placeholder="sonnet, opus…" maxLength={64} />
      </label>
      <label>
        <span className="mono">PERMISSIONS</span>
        <select name="permissionMode" defaultValue="manual">
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mono">OUTILS AUTORISÉS (vide = tous)</span>
        <input
          name="allowedTools"
          placeholder="Read, Grep, Bash(git status:*)"
        />
      </label>
      <label className="task-form-prompt">
        <span className="mono">PROMPT</span>
        <textarea
          name="prompt"
          required
          rows={3}
          maxLength={20000}
          onKeyDown={(e) => {
            if (!isSubmitShortcut(e)) return;
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }}
        />
      </label>
      <div className="task-form-actions">
        <button type="submit" className="task-btn primary" disabled={busy}>
          CRÉER (TODO)
        </button>
        <button type="button" className="task-btn" onClick={onCancel}>
          ANNULER
        </button>
        {error && (
          <span className="task-error mono" role="alert">
            {error}
          </span>
        )}
      </div>
    </form>
  );
}
