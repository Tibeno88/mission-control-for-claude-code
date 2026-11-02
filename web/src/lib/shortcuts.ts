import type { KeyboardEvent } from "react";

/** Single source for the help modal; keep in sync with the handlers. */
export const SHORTCUTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: "c", label: "Nouvelle tâche" },
  { keys: "Ctrl/Cmd + Entrée", label: "Soumettre le champ en cours" },
  { keys: "Échap", label: "Fermer toutes les fenêtres ouvertes" },
  { keys: "?", label: "Afficher / masquer cette aide" },
];

export const isSubmitShortcut = (e: KeyboardEvent): boolean =>
  e.key === "Enter" && (e.ctrlKey || e.metaKey);
