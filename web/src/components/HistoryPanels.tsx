import { useEffect, useState } from "react";
import { fmtTokens, fmtUSD, modelShort } from "../lib/format";
import { useBackup } from "../lib/useBackup";
import type {
  HistoryDayPoint,
  HistoryPeriod,
  MetricsBucket,
  MetricsPeriodsResponse,
} from "../types";
import { CostBars, type CostBarPoint } from "./CostBars";
import { Panel, RankBars, sumCost, TokenFlow, type RankRow } from "./HudPanel";

const PERIODS: Array<{ value: HistoryPeriod; label: string }> = [
  { value: "today", label: "AUJOURD'HUI" },
  { value: "7d", label: "7 JOURS" },
  { value: "30d", label: "30 JOURS" },
  { value: "all", label: "TOUT" },
];

const BUCKETS: Array<{
  value: MetricsBucket;
  label: string;
  lookbackDays: number;
}> = [
  { value: "day", label: "JOUR", lookbackDays: 30 },
  { value: "week", label: "SEMAINE", lookbackDays: 12 * 7 },
  { value: "month", label: "MOIS", lookbackDays: 365 },
];

const DAY_MS = 24 * 60 * 60 * 1000;

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
    byModel.set(point.model, {
      requests: entry.requests + point.requests,
      costUSD: entry.costUSD + point.costUSD,
      outputTokens: entry.outputTokens + point.outputTokens,
    });
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
 * The API only returns days with activity; fill the gaps with zero-cost days so
 * the x axis stays linear in time. Keys are "YYYY-MM-DD", stepped as UTC dates.
 */
export function fillDays(points: HistoryDayPoint[]): HistoryDayPoint[] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [];
  const byDay = new Map(points.map((point) => [point.day, point]));
  const filled: HistoryDayPoint[] = [];
  const end = Date.parse(`${last.day}T00:00:00Z`);
  for (
    let ms = Date.parse(`${first.day}T00:00:00Z`);
    ms <= end;
    ms += DAY_MS
  ) {
    const day = new Date(ms).toISOString().slice(0, 10);
    filled.push(byDay.get(day) ?? { day, costUSD: 0, tokens: 0 });
  }
  return filled;
}

/** `day` is a "YYYY-MM-DD" key. */
function toDayBar(point: HistoryDayPoint): CostBarPoint {
  const [, month = "", day = ""] = point.day.split("-");
  return {
    key: point.day,
    tick: `${day}/${month}`,
    costUSD: point.costUSD,
    details: [`${fmtTokens(point.tokens)} TOK`],
  };
}

/**
 * Requêtes/coût moyen/tokens de sortie moyens par modèle sur une fenêtre
 * jour/semaine/mois, indépendante des filtres période/compte : un simple
 * lookback client-side (30j / 12 semaines / 12 mois).
 */
function RequestCostPanel() {
  const [bucket, setBucket] = useState<MetricsBucket>("day");
  const [data, setData] = useState<MetricsPeriodsResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const config = BUCKETS.find((entry) => entry.value === bucket)!;
    const from = new Date(
      Date.now() - config.lookbackDays * DAY_MS,
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

  const granularity = (
    <span
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
    </span>
  );

  return (
    <Panel
      code="10"
      label="COÛT / REQUÊTE"
      className="h-requests"
      action={granularity}
    >
      {loading && !data && <p className="history-empty mono">CHARGEMENT…</p>}
      {data && rows.length === 0 && (
        <p className="history-empty mono">AUCUNE DONNÉE SUR LA PÉRIODE</p>
      )}
      {rows.length > 0 && (
        <table className="period-metrics-table mono">
          <thead>
            <tr>
              <th>MODÈLE</th>
              <th>REQ.</th>
              <th>COÛT MOY.</th>
              <th>OUT MOY.</th>
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
    </Panel>
  );
}

/** Metrics built from backup snapshots, filtered by period and account. */
export function HistoryPanels() {
  const backup = useBackup();
  const [period, setPeriod] = useState<HistoryPeriod>("7d");
  const [accountFilter, setAccountFilter] = useState<number | null>(null);

  useEffect(() => {
    void backup.loadAll(period, accountFilter, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, accountFilter]);

  const history = backup.history;
  const accounts: RankRow[] = (history?.byAccount ?? []).map((row) => ({
    key: String(row.accountId ?? "unassigned"),
    label: row.label,
    value: row.costUSD,
    detail: `${row.sessions} SESS.`,
    color: row.accountId === null ? "var(--text-faint)" : row.color,
  }));
  const projects: RankRow[] = (history?.byProject ?? [])
    .slice(0, 6)
    .map((row) => ({
      key: row.projectSlug,
      label: row.displayName,
      value: row.costUSD,
      detail: `${row.sessions} SESS.`,
    }));

  return (
    <section className="history-hud" aria-label="Historique archivé">
      <header className="dash-section-head">
        <h2 className="dash-section-title mono">
          <span className="dash-section-mark" aria-hidden="true" />
          HISTORIQUE ARCHIVÉ
        </h2>
        <div className="period-select mono" role="tablist" aria-label="Période">
          {PERIODS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              role="tab"
              aria-selected={period === entry.value}
              className={`period-btn ${period === entry.value ? "active" : ""}`}
              onClick={() => setPeriod(entry.value)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <label className="account-filter mono">
          <span>COMPTE</span>
          <select
            value={accountFilter ?? ""}
            onChange={(event) =>
              setAccountFilter(
                event.target.value === "" ? null : Number(event.target.value),
              )
            }
          >
            <option value="">TOUS</option>
            {backup.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {backup.lastError && (
        <div className="archive-error mono" role="alert">
          ERREUR // {backup.lastError}
        </div>
      )}

      {!history ? (
        <p className="history-empty mono">
          {backup.loading ? "CHARGEMENT DE L'HISTORIQUE…" : "AUCUNE DONNÉE"}
        </p>
      ) : (
        <div className="history-grid">
          <Panel code="06" label="TOTAUX · PÉRIODE" className="h-totals">
            <div className="h-cost">
              <span className="core-label mono">COÛT TOTAL</span>
              <span className="h-cost-value">
                {fmtUSD(history.totals.costUSD)}
              </span>
              <span className="flow-unit mono">
                {history.totals.sessions} SESSIONS
              </span>
            </div>
            <TokenFlow
              stats={history.totals}
              ariaLabel="Répartition des tokens sur la période"
            />
          </Panel>
          <Panel code="07" label="COÛT / JOUR · PÉRIODE" className="h-days">
            {history.timeline.length > 0 ? (
              <CostBars
                points={fillDays(history.timeline).map(toDayBar)}
                ariaLabel="Coût par jour sur la période"
                totalLabel="Σ PÉRIODE"
                height={220}
              />
            ) : (
              <p className="history-empty mono">AUCUNE DONNÉE SUR LA PÉRIODE</p>
            )}
          </Panel>
          <Panel code="08" label="PAR COMPTE · PÉRIODE" className="h-accounts">
            <RankBars rows={accounts} total={sumCost(history.byAccount)} />
          </Panel>
          <Panel code="09" label="PROJETS · PÉRIODE" className="h-projects">
            <RankBars rows={projects} total={sumCost(history.byProject)} />
          </Panel>
          <RequestCostPanel />
        </div>
      )}
    </section>
  );
}
