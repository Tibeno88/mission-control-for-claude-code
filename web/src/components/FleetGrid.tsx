import type { FleetSession } from "../types";
import { SessionCard } from "./SessionCard";

interface FleetGridProps {
  sessions: FleetSession[];
  selectedId: string | null;
  onSelect: (sessionId: string) => void;
  onDismiss: (sessionId: string) => void;
}

export function FleetGrid({
  sessions,
  selectedId,
  onSelect,
  onDismiss,
}: FleetGridProps) {
  if (sessions.length === 0) {
    return (
      <div className="fleet-empty mono">NO SESSIONS DETECTED — STANDBY</div>
    );
  }
  return (
    <section className="fleet" aria-label="Sessions Claude Code">
      {sessions.map((session) => (
        <SessionCard
          key={session.sessionId}
          session={session}
          selected={session.sessionId === selectedId}
          onSelect={onSelect}
          onDismiss={onDismiss}
        />
      ))}
    </section>
  );
}
