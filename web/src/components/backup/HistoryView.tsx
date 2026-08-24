import { useEffect, useState } from "react";
import { fmtTokens, fmtUSD, modelShort } from "../../lib/format";
import type {
  HistoryResponse,
  MetricsBucket,
  MetricsPeriodsResponse,
} from "../../types";

interface HistoryViewProps {
  history: HistoryResponse | null;
  loading: boolean;
}

const BUCKETS: Array<{
  value: MetricsBucket;
  label: string;
  lookbackDays: number;
}> = [
  { value: "day", label: "JOUR", lookbackDays: 30 },
  { value: "week", label: "SEMAINE", lookbackDays: 12 * 7 },
  { value: "month", label: "MOIS", lookbackDays: 365 },
];

interface ModelAverageRow {
  model: string;
  requests: number;
  avgCostUSD: number;
  avgOutputTokens: number;
}

function toModelAverages(
  data: MetricsPeriodsResponse | null,
): ModelAverageRow[] {
  if (!data) return [];
  const byModel = new Map<
    string,
    { requests: number; costUSD: number; outputTokens: number }
  >();
  for (const point of data.points) {
    const entry = byModel.get(point.model) ?? {
      requests: 0,
      costUSD: 0,
      outputTokens: 0,
    };
    entry.requests += point.requests;
    entry.costUSD += point.costUSD;
    entry.outputTokens += point.outputTokens;
    byModel.set(point.model, entry);
  }
  return [...byModel.entries()]
    .map(([model, agg]) => ({
      model,
      requests: agg.requests,
      avgCostUSD: agg.requests > 0 ? agg.costUSD / agg.requests : 0,
      avgOutputTokens: agg.requests > 0 ? agg.outputTokens / agg.requests : 0,
    }))
    .sort((a, b) => b.requests - a.requests);
}

/**
 * Requêtes/coût moyen/tokens de sortie moyens par modèle sur une fenêtre
 * jour/semaine/mois, indépendante du filtre compte/projet de la vue archive :
 * un simple lookback client-side (30j / 12 semaines / 12 mois).
 */
function PeriodMetrics() {
  const [bucket, setBucket] = useState<MetricsBucket>("day");
  const [data, setData] = useState<MetricsPeriodsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const config = BUCKETS.find((entry) => entry.value === bucket)!;
    const from = new Date(
      Date.now() - config.lookbackDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    fetch(
      `/api/metrics/periods?bucket=${bucket}&from=${encodeURIComponent(from)}`,
    )
      .then((response) => response.json() as Promise<MetricsPeriodsResponse>)
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bucket]);

  const rows = toModelAverages(data);

  return (
    <>
      <h3 className="history-subtitle mono">
        COÛT &amp; TOKENS PAR REQUÊTE (ESTIMÉ)
      </h3>
      <div
        className="period-select mono"
        role="tablist"
        aria-label="Granularité"
      >
        {BUCKETS.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={bucket === entry.value}
            className={`period-btn ${bucket === entry.value ? "active" : ""}`}
            onClick={() => setBucket(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {loading && !data && <p className="history-empty mono">CHARGEMENT…</p>}
      {data && rows.length === 0 && (
        <p className="history-empty mono">AUCUNE DONNÉE SUR LA PÉRIODE</p>
      )}
      {rows.length > 0 && (
        <table className="period-metrics-table mono">
          <thead>
            <tr>
              <th>MODÈLE</th>
              <th>REQUÊTES</th>
              <th>COÛT MOY./REQ.</th>
              <th>TOKENS OUT MOY./REQ.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.model}>
                <td>{modelShort(row.model)}</td>
                <td>{row.requests}</td>
                <td>{fmtUSD(row.avgCostUSD)}</td>
                <td>{fmtTokens(Math.round(row.avgOutputTokens))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.note && <p className="history-note mono">{data.note}</p>}
      <p className="history-note mono">
        COÛT ESTIMÉ SELON TARIFS PUBLICS — PAS UNE FACTURE.
      </p>
    </>
  );
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

      <PeriodMetrics />
    </section>
  );
}
