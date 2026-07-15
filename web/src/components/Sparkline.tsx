interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
}

export function Sparkline({
  points,
  width = 260,
  height = 56,
}: SparklineProps) {
  if (points.length === 0) return null;
  const max = Math.max(...points, 1e-9);
  const stepX = width / Math.max(points.length - 1, 1);
  const coords = points.map(
    (value, index) =>
      [index * stepX, height - 4 - (value / max) * (height - 12)] as const,
  );
  const line = coords
    .map(
      ([x, y], index) =>
        `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`,
    )
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = coords[coords.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="sparkline"
      role="img"
      aria-label="Coût par heure sur les dernières 24 heures"
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--cyan)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--cyan)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1="0"
        y1={height - 0.5}
        x2={width}
        y2={height - 0.5}
        stroke="var(--line)"
        strokeWidth="1"
      />
      <path d={area} fill="url(#spark-fill)" />
      <path d={line} fill="none" stroke="var(--cyan)" strokeWidth="1.5" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--cyan)" />}
    </svg>
  );
}
