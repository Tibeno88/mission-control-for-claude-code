import { fmtTokens, fmtUSD } from "../../lib/format";
import type { HistoryResponse } from "../../types";

interface HistoryViewProps {
  history: HistoryResponse | null;
  loading: boolean;
}

function TimelineBars({ history }: { history: HistoryResponse }) {
  const points = history.timeline;
  if (points.length === 0) {
    return <p className="history-empty mono">AUCUNE DONNÉE SUR LA PÉRIODE</p>;
  }
  const width = 320;
  const height = 90;
  const barGap = 3;
  const barWidth = Math.max(2, width / points.length - barGap);
  const max = Math.max(...points.map((point) => point.costUSD), 1e-9);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="history-timeline"
      role="img"
      aria-label="Coût par jour sur la période sélectionnée"
    >
      <line
        x1="0"
        y1={height - 0.5}
        x2={width}
        y2={height - 0.5}
        stroke="var(--line)"
        strokeWidth="1"
      />
      {points.map((point, index) => {
        const barHeight = Math.max(1, (point.costUSD / max) * (height - 14));
        const x = index * (barWidth + barGap);
        const y = height - barHeight;
        return (
          <rect
            key={point.day}
            x={x}
            y={y}
            width={barWidth}
            height={barHeight}
            fill="var(--cyan)"
            opacity={0.75}
          >
            <title>{`${point.day}: ${fmtUSD(point.costUSD)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

function AccountBars({ history }: { history: HistoryResponse }) {
  const rows = history.byAccount;
  const max = Math.max(...rows.map((row) => row.costUSD), 1e-9);
  if (rows.length === 0) {
    return <p className="history-empty mono">AUCUNE RÉPARTITION</p>;
  }
  return (
    <ul className="account-bars">
      {rows.map((row) => (
        <li key={row.accountId ?? "unassigned"} className="account-bar-row">
          <span className="account-bar-label mono">
            <span
              className="account-dot"
              style={{
                background:
                  row.accountId === null ? "var(--text-faint)" : row.color,
              }}
              aria-hidden="true"
            />
            {row.label}
          </span>
          <div className="account-bar-track">
            <div
              className="account-bar-fill"
              style={{
                transform: `scaleX(${Math.max(0.01, row.costUSD / max)})`,
                background:
                  row.accountId === null ? "var(--text-faint)" : row.color,
              }}
            />
          </div>
          <span className="account-bar-value mono">{fmtUSD(row.costUSD)}</span>
        </li>
      ))}
    </ul>
  );
}

export function HistoryView({ history, loading }: HistoryViewProps) {
  if (loading && !history) {
    return (
      <section className="history-view" aria-label="Historique">
        <p className="history-empty mono">CHARGEMENT DE L&apos;HISTORIQUE…</p>
      </section>
    );
  }
  if (!history) return null;

  const { totals } = history;

  return (
    <section className="history-view" aria-label="Historique">
      <div className="history-totals">
        <div className="history-tile">
          <span className="tile-label">TOKENS IN/OUT</span>
          <span className="tile-value small">
            {fmtTokens(totals.inputTokens)} / {fmtTokens(totals.outputTokens)}
          </span>
        </div>
        <div className="history-tile">
          <span className="tile-label">CACHE R/W</span>
          <span className="tile-value small">
            {fmtTokens(totals.cacheReadTokens)} /{" "}
            {fmtTokens(totals.cacheWriteTokens)}
          </span>
        </div>
        <div className="history-tile accent">
          <span className="tile-label">COÛT TOTAL</span>
          <span className="tile-value">{fmtUSD(totals.costUSD)}</span>
        </div>
        <div className="history-tile">
          <span className="tile-label">SESSIONS</span>
          <span className="tile-value small">{totals.sessions}</span>
        </div>
      </div>

      <h3 className="history-subtitle mono">COÛT / JOUR</h3>
      <TimelineBars history={history} />

      <h3 className="history-subtitle mono">PAR COMPTE</h3>
      <AccountBars history={history} />

      <h3 className="history-subtitle mono">TOP PROJETS</h3>
      <ul className="tile-list top-projects mono">
        {history.byProject.slice(0, 6).map((project) => (
          <li key={project.projectSlug}>
            <span className="tile-list-name">{project.displayName}</span>
            <span className="mono">{fmtUSD(project.costUSD)}</span>
          </li>
        ))}
        {history.byProject.length === 0 && (
          <li className="tile-list-empty">NO DATA</li>
        )}
      </ul>
    </section>
  );
}
