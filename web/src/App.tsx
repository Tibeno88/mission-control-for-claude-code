import { useState } from "react";
import { FleetGrid } from "./components/FleetGrid";
import { Header } from "./components/Header";
import { MetricsBar } from "./components/MetricsBar";
import { SessionDetail } from "./components/SessionDetail";
import { useSnapshot } from "./lib/useSnapshot";

export default function App() {
  const { snap, connected } = useSnapshot();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const fleet = snap?.fleet ?? [];
  const selected =
    fleet.find((session) => session.sessionId === selectedId) ?? null;

  return (
    <div className="app">
      <div className="hud-overlay" aria-hidden="true" />
      <Header connected={connected} fleet={fleet} />
      <main className="layout">
        {snap ? (
          <>
            <MetricsBar metrics={snap.metrics} />
            <FleetGrid
              sessions={fleet}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          </>
        ) : (
          <div className="boot mono">
            ESTABLISHING UPLINK<span className="blink">▌</span>
          </div>
        )}
      </main>
      {selected && (
        <SessionDetail session={selected} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}
