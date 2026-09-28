import { useState } from "react";
import { ArchiveView } from "./components/backup/ArchiveView";
import { FleetGrid } from "./components/FleetGrid";
import { Header } from "./components/Header";
import { HistoryPanels } from "./components/HistoryPanels";
import type { MainView } from "./components/Header";
import { MetricsBar } from "./components/MetricsBar";
import { SessionDetail } from "./components/SessionDetail";
import { useNotifications } from "./lib/useNotifications";
import { useSnapshot } from "./lib/useSnapshot";

export default function App() {
  const { snap, connected } = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<MainView>("live");

  const fleet = (snap?.fleet ?? []).filter(
    (session) => !dismissed.has(session.sessionId),
  );
  const { notifPermission } = useNotifications(fleet);
  const selected =
    fleet.find((session) => session.sessionId === selectedId) ?? null;

  const dismissSession = (sessionId: string): void => {
    setDismissed((previous) => new Set(previous).add(sessionId));
    setSelectedId((current) => (current === sessionId ? null : current));
    void fetch(`/api/sessions/${sessionId}/dismiss`, { method: "POST" }).catch(
      () => undefined,
    );
  };

  return (
    <div className="app">
      <div className="hud-overlay" aria-hidden="true" />
      <Header
        connected={connected}
        fleet={fleet}
        plannotator={snap?.plannotator ?? []}
        notifPermission={notifPermission}
        view={view}
        onViewChange={setView}
      />
      <main className="layout">
        {view === "config" ? (
          <ArchiveView />
        ) : !snap ? (
          <div className="boot mono">
            ESTABLISHING UPLINK<span className="blink">▌</span>
          </div>
        ) : view === "dashboard" ? (
          <>
            <MetricsBar metrics={snap.metrics} />
            <HistoryPanels />
          </>
        ) : (
          <FleetGrid
            sessions={fleet}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDismiss={dismissSession}
          />
        )}
      </main>
      {view === "live" && selected && (
        <SessionDetail session={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
