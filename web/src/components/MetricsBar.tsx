import { fmtTokens, fmtUSD } from "../lib/format";
import type { GlobalMetrics } from "../types";
import { Sparkline } from "./Sparkline";

interface TileProps {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}

function Tile({ label, value, sub, accent = false }: TileProps) {
  return (
    <div className={`tile ${accent ? "accent" : ""}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {sub && <span className="tile-sub mono">{sub}</span>}
    </div>
  );
}

export function MetricsBar({ metrics }: { metrics: GlobalMetrics }) {
  const today = metrics.today;
  const costPoints = metrics.timeline24h.map((point) => point.costUSD);

  return (
    <section className="metrics" aria-label="Métriques de consommation">
      <Tile
        label="TOKENS TODAY"
        value={fmtTokens(today.inputTokens + today.outputTokens)}
        sub={`IN ${fmtTokens(today.inputTokens)} · OUT ${fmtTokens(today.outputTokens)}`}
      />
      <Tile
        label="CACHE TODAY"
        value={fmtTokens(today.cacheReadTokens + today.cacheWriteTokens)}
        sub={`READ ${fmtTokens(today.cacheReadTokens)} · WRITE ${fmtTokens(today.cacheWriteTokens)}`}
      />
      <Tile
        label="COST TODAY"
        value={fmtUSD(today.costUSD)}
        sub={`${today.sessions} SESSIONS`}
        accent
      />
      <Tile
        label="COST 7 DAYS"
        value={fmtUSD(metrics.last7d.costUSD)}
        sub={`${metrics.last7d.sessions} SESSIONS`}
      />
      <div className="tile wide">
        <span className="tile-label">COST / HOUR · LAST 24H</span>
        <Sparkline points={costPoints} />
      </div>
      <div className="tile projects">
        <span className="tile-label">TOP PROJECTS · SCAN</span>
        <ul className="tile-list">
          {metrics.byProject.slice(0, 3).map((project) => (
            <li key={project.project}>
              <span className="tile-list-name">{project.project}</span>
              <span className="mono">{fmtUSD(project.costUSD)}</span>
            </li>
          ))}
          {metrics.byProject.length === 0 && (
            <li className="tile-list-empty mono">NO DATA</li>
          )}
        </ul>
      </div>
    </section>
  );
}
