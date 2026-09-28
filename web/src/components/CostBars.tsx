import { useEffect, useRef, useState } from "react";
import { fmtUSD } from "../lib/format";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 120;
const PLOT_TOP = 18;
const AXIS_SPACE = 16;
const GAP = 2;
const MAX_TICKS = 5;
/** Few points (e.g. 2 days) must not turn into slabs. */
const MAX_BAR_WIDTH = 28;

export interface CostBarPoint {
  key: string;
  /** Axis / readout label, e.g. "14H" or "28/09". */
  tick: string;
  costUSD: number;
  /** Extra readout fields shown on hover, e.g. "OUT 12k". */
  details: string[];
}

interface CostBarsProps {
  points: CostBarPoint[];
  ariaLabel: string;
  /** Label of the resting readout, e.g. "Σ 24H". */
  totalLabel: string;
  /** Highlight the last bar as the current slot and label it NOW. */
  lastIsNow?: boolean;
  /** Drawing height in px. */
  height?: number;
}

export function CostBars({
  points,
  ariaLabel,
  totalLabel,
  lastIsNow = false,
  height = DEFAULT_HEIGHT,
}: CostBarsProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  // Draw at the real pixel width so text and bars keep their size at any panel width.
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(120, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (points.length === 0) return null;

  const max = Math.max(...points.map((point) => point.costUSD), 1e-9);
  const peakIndex = points.findIndex((point) => point.costUSD === max);
  const slot = width / points.length;
  const barWidth = Math.max(1, Math.min(slot - GAP, MAX_BAR_WIDTH));
  const plotBottom = height - AXIS_SPACE;
  const plotHeight = plotBottom - PLOT_TOP;
  const active = hovered === null ? null : points[hovered];
  const total = points.reduce((sum, point) => sum + point.costUSD, 0);
  const lastIndex = points.length - 1;
  const tickEvery = Math.max(1, Math.ceil(points.length / MAX_TICKS));
  const showTick = (index: number) =>
    index === lastIndex ||
    (index % tickEvery === 0 && lastIndex - index >= tickEvery / 2);

  return (
    <div className="timeline" ref={containerRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="timeline-svg"
        role="img"
        aria-label={`${ariaLabel} : total ${fmtUSD(total)}, pic ${fmtUSD(max)}`}
        onMouseLeave={() => setHovered(null)}
      >
        {[0.5, 1].map((fraction) => (
          <line
            key={fraction}
            className="timeline-grid"
            x1="0"
            x2={width}
            y1={plotBottom - fraction * plotHeight}
            y2={plotBottom - fraction * plotHeight}
          />
        ))}
        <line
          className="timeline-base"
          x1="0"
          x2={width}
          y1={plotBottom + 0.5}
          y2={plotBottom + 0.5}
        />
        {points.map((point, index) => {
          const barHeight =
            point.costUSD > 0
              ? Math.max(2, (point.costUSD / max) * plotHeight)
              : 0;
          const classes = [
            "timeline-bar",
            lastIsNow && index === lastIndex ? "now" : "",
            index === peakIndex && max > 1e-9 ? "peak" : "",
            hovered === index ? "hover" : "",
          ].join(" ");
          return (
            <g key={point.key}>
              <rect
                className={classes}
                x={index * slot + (slot - barWidth) / 2}
                y={plotBottom - barHeight}
                width={barWidth}
                height={barHeight}
                rx="1.5"
              />
              {/* Full-height hit target: easier to hover than a thin bar. */}
              <rect
                className="timeline-hit"
                x={index * slot}
                y={0}
                width={slot}
                height={plotBottom}
                onMouseEnter={() => setHovered(index)}
              >
                <title>{`${point.tick} · ${fmtUSD(point.costUSD)}`}</title>
              </rect>
            </g>
          );
        })}
        {max > 1e-9 && (
          <text
            className="timeline-peak-label"
            x={Math.min(Math.max(peakIndex * slot + slot / 2, 30), width - 30)}
            y={PLOT_TOP - 6}
            textAnchor="middle"
          >
            PEAK {fmtUSD(max)}
          </text>
        )}
        {points.map((point, index) =>
          !showTick(index) ? null : (
            <text
              key={point.key}
              className={`timeline-tick ${lastIsNow && index === lastIndex ? "now" : ""}`}
              x={
                index === 0
                  ? 0
                  : index === lastIndex
                    ? width
                    : index * slot + slot / 2
              }
              y={height - 3}
              textAnchor={
                index === 0 ? "start" : index === lastIndex ? "end" : "middle"
              }
            >
              {lastIsNow && index === lastIndex ? "NOW" : point.tick}
            </text>
          ),
        )}
      </svg>
      <div className={`timeline-readout mono ${active ? "on" : ""}`}>
        {active ? (
          <>
            <span className="readout-hour">{active.tick}</span>
            <span className="readout-cost">{fmtUSD(active.costUSD)}</span>
            {active.details.map((detail) => (
              <span key={detail}>{detail}</span>
            ))}
          </>
        ) : (
          <>
            <span className="readout-hour">{totalLabel}</span>
            <span className="readout-cost">{fmtUSD(total)}</span>
            <span className="readout-hint">SURVOLER UNE BARRE</span>
          </>
        )}
      </div>
    </div>
  );
}
