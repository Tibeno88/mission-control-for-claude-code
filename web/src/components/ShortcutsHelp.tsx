import { useEffect, useRef, useState } from "react";
import { SHORTCUTS } from "../lib/shortcuts";

const isTyping = (target: EventTarget | null): boolean =>
  !!(target as HTMLElement | null)?.closest?.(
    "input, textarea, select, [contenteditable]",
  );

export function ShortcutsHelp() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Native <dialog>: showModal() puts it in the top layer, above any other modal.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        // Native Escape only closes the topmost dialog; close the whole stack.
        document
          .querySelectorAll<HTMLDialogElement>("dialog[open]")
          .forEach((d) => d.close());
        return;
      }
      if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTyping(e.target)) return;
      e.preventDefault();
      setOpen((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <>
      <button
        type="button"
        className="shortcuts-fab mono"
        aria-label="Raccourcis clavier"
        aria-keyshortcuts="?"
        title="Raccourcis clavier (?)"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      <dialog
        ref={dialogRef}
        className="shortcuts-modal"
        aria-label="Raccourcis clavier"
        onClose={() => setOpen(false)}
      >
        {open && (
          <>
            <h3 className="mono">RACCOURCIS CLAVIER</h3>
            <dl>
              {SHORTCUTS.map((s) => (
                <div key={s.keys}>
                  <dt>
                    <kbd className="mono">{s.keys}</kbd>
                  </dt>
                  <dd>{s.label}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </dialog>
    </>
  );
}
