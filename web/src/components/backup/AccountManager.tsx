import { useState } from "react";
import type { FormEvent } from "react";
import type { UseBackupState } from "../../lib/useBackup";
import type { ProjectMapEntry } from "../../types";

interface AccountManagerProps {
  backup: UseBackupState;
}

const DEFAULT_COLOR = "#3fd9ff";

function AccountForm({ backup }: { backup: UseBackupState }) {
  const [label, setLabel] = useState("");
  const [email, setEmail] = useState("");
  const [organizationName, setOrganizationName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!label.trim()) {
      setError("Label requis");
      return;
    }
    setError(null);
    void backup
      .createAccount({
        label: label.trim(),
        email: email.trim() || undefined,
        organizationName: organizationName.trim() || undefined,
        color,
      })
      .then(() => {
        setLabel("");
        setEmail("");
        setOrganizationName("");
        setColor(DEFAULT_COLOR);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Échec de la création");
      });
  };

  return (
    <form className="account-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Label"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className="mono"
        aria-label="Label du compte"
      />
      <input
        type="email"
        placeholder="Email (optionnel)"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="mono"
        aria-label="Email du compte"
      />
      <input
        type="text"
        placeholder="Organisation (optionnel)"
        value={organizationName}
        onChange={(event) => setOrganizationName(event.target.value)}
        className="mono"
        aria-label="Organisation"
      />
      <input
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        className="account-color-input"
        aria-label="Couleur du compte"
      />
      <button type="submit" className="form-submit mono">
        AJOUTER
      </button>
      {error && <span className="form-error mono">{error}</span>}
    </form>
  );
}

function ProjectMapRow({
  entry,
  backup,
}: {
  entry: ProjectMapEntry;
  backup: UseBackupState;
}) {
  const [accountId, setAccountId] = useState<number | null>(entry.accountId);
  const [saving, setSaving] = useState(false);

  const handleChange = (value: string): void => {
    const previous = accountId;
    const next = value === "" ? null : Number(value);
    setAccountId(next);
    setSaving(true);
    void backup
      .putProjectMap(entry.projectSlug, next)
      .catch(() => {
        setAccountId(previous);
      })
      .finally(() => setSaving(false));
  };

  return (
    <li className="project-map-row mono">
      <span className="project-map-name">{entry.displayName}</span>
      <span className="project-map-sessions">{entry.sessions} sess.</span>
      <select
        value={accountId ?? ""}
        onChange={(event) => handleChange(event.target.value)}
        disabled={saving}
        aria-label={`Compte pour ${entry.displayName}`}
      >
        <option value="">Non assigné</option>
        {backup.accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.label}
          </option>
        ))}
      </select>
    </li>
  );
}

export function AccountManager({ backup }: AccountManagerProps) {
  return (
    <section className="account-manager" aria-label="Gestion des comptes">
      <h3 className="panel-title mono">COMPTES</h3>
      <ul className="account-list">
        {backup.accounts.map((account) => (
          <li key={account.id} className="account-list-row mono">
            <span
              className="account-dot"
              style={{ background: account.color }}
              aria-hidden="true"
            />
            <span className="account-label">{account.label}</span>
            {account.organizationName && (
              <span className="account-org">{account.organizationName}</span>
            )}
            <button
              type="button"
              className="account-delete"
              aria-label={`Supprimer le compte ${account.label}`}
              onClick={() =>
                void backup.deleteAccount(account.id).catch(() => undefined)
              }
            >
              ✕
            </button>
          </li>
        ))}
        {backup.accounts.length === 0 && (
          <li className="tile-list-empty mono">AUCUN COMPTE</li>
        )}
      </ul>

      <AccountForm backup={backup} />

      <h3 className="panel-title mono">PROJET → COMPTE</h3>
      <ul className="project-map-list">
        {backup.projectMap.map((entry) => (
          <ProjectMapRow
            key={entry.projectSlug}
            entry={entry}
            backup={backup}
          />
        ))}
        {backup.projectMap.length === 0 && (
          <li className="tile-list-empty mono">AUCUN PROJET</li>
        )}
      </ul>
    </section>
  );
}
