import type { ReactNode } from "react";
import { fmtTokens, fmtUSD } from "../lib/format";
import type { PeriodStats } from "../types";

interface PanelProps {
  code: string;
  label: string;
  className?: string;
  /** Right-aligned header slot, e.g. a granularity switch. */
  action?: ReactNode;
  children: ReactNode;
}

export function Panel({
  code,
  label,
  className = "",
  action,
  children,
}: PanelProps) {
  return (
    <div className={`hud-panel ${className}`}>
      <span className="corner tl" aria-hidden="true" />
      <span className="corner tr" aria-hidden="true" />
      <span className="corner bl" aria-hidden="true" />
      <span className="corner br" aria-hidden="true" />
      <header className="hud-panel-head mono">
        <span className="hud-panel-code">{code}</span>
        <span className="hud-panel-label">{label}</span>
        {action && <span className="hud-panel-action">{action}</span>}
      </header>
      {children}
    </div>
  );
}

type TokenStats = Pick<
  PeriodStats,
  "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"
>;

const FLOW_SEGMENTS = [
  { key: "inputTokens", label: "IN", className: "seg-in" },
  { key: "outputTokens", label: "OUT", className: "seg-out" },
  { key: "cacheReadTokens", label: "CACHE READ", className: "seg-cr" },
  { key: "cacheWriteTokens", label: "CACHE WRITE", className: "seg-cw" },
] as const;

export function TokenFlow({
  stats,
  ariaLabel,
}: {
  stats: TokenStats;
  ariaLabel: string;
}) {
  const total = FLOW_SEGMENTS.reduce((sum, seg) => sum + stats[seg.key], 0);
  const promptSide =
    stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens;
  const hitRate = promptSide > 0 ? stats.cacheReadTokens / promptSide : 0;
  const pct = (value: number) =>
    total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "—";

  return (
    <>
      <div className="flow-headline">
        <span className="flow-value">
          {fmtTokens(stats.inputTokens + stats.outputTokens)}
        </span>
        <span className="flow-unit mono">
          TOKENS I/O · +
          {fmtTokens(stats.cacheReadTokens + stats.cacheWriteTokens)} CACHE
        </span>
      </div>
      <div className="flow-bar" role="img" aria-label={ariaLabel}>
        {total > 0 ? (
          FLOW_SEGMENTS.map((seg) =>
            stats[seg.key] > 0 ? (
              <span
                key={seg.key}
                className={`flow-seg ${seg.className}`}
                style={{ flexGrow: stats[seg.key] }}
                title={`${seg.label} ${fmtTokens(stats[seg.key])} (${pct(stats[seg.key])})`}
              />
            ) : null,
          )
        ) : (
          <span className="flow-seg empty" />
        )}
      </div>
      <ul className="flow-legend mono">
        {FLOW_SEGMENTS.map((seg) => (
          <li key={seg.key}>
            <span
              className={`flow-swatch ${seg.className}`}
              aria-hidden="true"
            />
            <span className="flow-legend-label">{seg.label}</span>
            <span className="flow-legend-value">
              {fmtTokens(stats[seg.key])}
            </span>
            <span className="flow-legend-pct">{pct(stats[seg.key])}</span>
          </li>
        ))}
      </ul>
      <div className="flow-hit mono">
        <span>CACHE HIT</span>
        <div className="meter" aria-hidden="true">
          <span
            className="meter-fill"
            style={{ transform: `scaleX(${hitRate})` }}
          />
        </div>
        <span className="flow-hit-value">{(hitRate * 100).toFixed(0)}%</span>
      </div>
    </>
  );
}

export interface RankRow {
  key: string;
  label: string;
  value: number;
  detail: string;
  /** Identity color (e.g. an account's), shown as a swatch beside the label. */
  color?: string;
}

export function sumCost(items: ReadonlyArray<{ costUSD: number }>): number {
  return items.reduce((sum, item) => sum + item.costUSD, 0);
}

/** `total` spans every entry, not only the rows shown, so shares stay honest. */
export function RankBars({ rows, total }: { rows: RankRow[]; total: number }) {
  if (rows.length === 0) {
    return <p className="rank-empty mono">NO DATA</p>;
  }
  const max = Math.max(...rows.map((row) => row.value), 1e-9);
  return (
    <ol className="rank">
      {rows.map((row, index) => (
        <li key={row.key} className="rank-row">
          <span className="rank-index mono">
            {String(index + 1).padStart(2, "0")}
          </span>
          <span className="rank-label" title={row.label}>
            {row.color && (
              <span
                className="rank-swatch"
                style={{ background: row.color }}
                aria-hidden="true"
              />
            )}
            {row.label}
          </span>
          <span className="rank-value mono">{fmtUSD(row.value)}</span>
          <div className="rank-track" aria-hidden="true">
            <span
              className="rank-fill"
              style={{
                transform: `scaleX(${Math.max(0.01, row.value / max)})`,
              }}
            />
          </div>
          <span className="rank-detail mono">
            {row.detail} ·{" "}
            {total > 0 ? Math.round((row.value / total) * 100) : 0}%
          </span>
        </li>
      ))}
    </ol>
  );
}
