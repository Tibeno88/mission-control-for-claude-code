import { fmtTokens, fmtUSD, modelShort } from "../lib/format";
import type { GlobalMetrics, HourPoint } from "../types";
import { CostBars, type CostBarPoint } from "./CostBars";
import { Panel, RankBars, sumCost, TokenFlow, type RankRow } from "./HudPanel";

/** Gauge full scale = this multiple of the 7-day daily average (tick sits at 1×). */
const GAUGE_SCALE = 1.5;
const GAUGE_RADIUS = 54;
/** The arc spans 270°, open at the bottom, starting at 135°. */
const GAUGE_START_DEG = 135;
const GAUGE_SWEEP_DEG = 270;

function CostCore({ today, last7d }: { today: number; last7d: number }) {
  const dailyAvg = last7d / 7;
  const ratio = dailyAvg > 0 ? today / dailyAvg : 0;
  const fill = Math.min(ratio / GAUGE_SCALE, 1);
  const circumference = 2 * Math.PI * GAUGE_RADIUS;
  const arc = (circumference * GAUGE_SWEEP_DEG) / 360;
  const over = ratio > 1;
  const delta = Math.round((ratio - 1) * 100);
  const tickRad =
    ((GAUGE_START_DEG + GAUGE_SWEEP_DEG / GAUGE_SCALE) * Math.PI) / 180;
  const tickPoint = (r: number) =>
    [60 + r * Math.cos(tickRad), 60 + r * Math.sin(tickRad)] as const;
  const [tx1, ty1] = tickPoint(GAUGE_RADIUS - 8);
  const [tx2, ty2] = tickPoint(GAUGE_RADIUS + 8);

  return (
    <div className="core">
      <svg
        viewBox="0 0 120 120"
        className={`core-gauge ${over ? "over" : ""}`}
        role="img"
        aria-label={`Coût du jour ${fmtUSD(today)}, moyenne journalière sur 7 jours ${fmtUSD(dailyAvg)}`}
      >
        <circle className="core-orbit" cx="60" cy="60" r="58" />
        <g transform={`rotate(${GAUGE_START_DEG} 60 60)`}>
          <circle
            className="core-track"
            cx="60"
            cy="60"
            r={GAUGE_RADIUS}
            strokeDasharray={`${arc} ${circumference}`}
          />
          <circle
            className="core-fill"
            cx="60"
            cy="60"
            r={GAUGE_RADIUS}
            strokeDasharray={`${arc * fill} ${circumference}`}
          />
        </g>
        {dailyAvg > 0 && (
          <line className="core-tick" x1={tx1} y1={ty1} x2={tx2} y2={ty2} />
        )}
        <circle className="core-inner" cx="60" cy="60" r="40" />
      </svg>
      <div className="core-readout">
        <span className="core-label mono">COST TODAY</span>
        <span className="core-value">{fmtUSD(today)}</span>
        {dailyAvg > 0 ? (
          <span className={`core-delta mono ${over ? "over" : "under"}`}>
            {over ? "▲" : "▼"} {delta > 0 ? "+" : ""}
            {delta}% VS MOY.
          </span>
        ) : (
          <span className="core-delta mono">NO BASELINE</span>
        )}
      </div>
    </div>
  );
}

/** `hour` is a UTC "YYYY-MM-DDTHH" key; display it in local time. */
function toHourBar(point: HourPoint): CostBarPoint {
  const hour = new Date(`${point.hour}:00:00Z`).getHours();
  return {
    key: point.hour,
    tick: `${String(hour).padStart(2, "0")}H`,
    costUSD: point.costUSD,
    details: [
      `IN ${fmtTokens(point.inputTokens)}`,
      `OUT ${fmtTokens(point.outputTokens)}`,
      `CACHE ${fmtTokens(point.cacheReadTokens + point.cacheWriteTokens)}`,
    ],
  };
}

export function MetricsBar({ metrics }: { metrics: GlobalMetrics }) {
  const { today, last7d } = metrics;

  const models: RankRow[] = metrics.byModel.slice(0, 4).map((model) => ({
    key: model.model,
    label: modelShort(model.model),
    value: model.costUSD,
    detail: `OUT ${fmtTokens(model.outputTokens)}`,
  }));
  const projects: RankRow[] = metrics.byProject.slice(0, 5).map((project) => ({
    key: project.project,
    label: project.project,
    value: project.costUSD,
    detail: `${project.sessions} SESS.`,
  }));

  return (
    <section className="metrics" aria-label="Métriques temps réel">
      <Panel code="01" label="CORE · COÛT" className="m-core">
        <CostCore today={today.costUSD} last7d={last7d.costUSD} />
        <dl className="core-stats mono">
          <div>
            <dt>7 JOURS</dt>
            <dd>{fmtUSD(last7d.costUSD)}</dd>
          </div>
          <div>
            <dt>MOY./JOUR</dt>
            <dd>{fmtUSD(last7d.costUSD / 7)}</dd>
          </div>
          <div>
            <dt>SESSIONS</dt>
            <dd>
              {today.sessions}
              <span className="dim"> / {last7d.sessions}</span>
            </dd>
          </div>
        </dl>
      </Panel>
      <Panel code="02" label="FLUX TOKENS · AUJOURD'HUI" className="m-flow">
        <TokenFlow stats={today} ariaLabel="Répartition des tokens du jour" />
      </Panel>
      <Panel code="03" label="TÉLÉMÉTRIE · COÛT / HEURE" className="m-timeline">
        <CostBars
          points={metrics.timeline24h.map(toHourBar)}
          ariaLabel="Coût par heure sur 24 heures"
          totalLabel="Σ 24H"
          lastIsNow
        />
      </Panel>
      <Panel code="04" label="MODÈLES · SCAN" className="m-models">
        <RankBars rows={models} total={sumCost(metrics.byModel)} />
      </Panel>
      <Panel code="05" label="PROJETS · SCAN" className="m-projects">
        <RankBars rows={projects} total={sumCost(metrics.byProject)} />
      </Panel>
    </section>
  );
}
