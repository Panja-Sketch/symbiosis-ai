import type { SeriesPoint } from "../../lib/sim-types";

/**
 * A small, dependency-free line chart. It plots stored canonical observations and, when given, the
 * learned baseline (dashed) and moments on the time axis (the action report, the verification
 * window). It draws what the backend returned; it computes no verdict.
 */
export type Marker = {
  readonly t: number;
  readonly label: string;
  readonly tone?: "warn" | "good" | "info";
};
export type Band = { readonly from: number; readonly to: number; readonly label: string };

const W = 520;
const H = 160;
const PAD = { l: 44, r: 12, t: 12, b: 26 };

export function LineChart({
  title,
  unit,
  points,
  baseline,
  fromMs,
  toMs,
  markers = [],
  bands = [],
  step = false,
}: {
  readonly title: string;
  readonly unit: string;
  readonly points: readonly SeriesPoint[];
  readonly baseline?: number | null;
  readonly fromMs: number;
  readonly toMs: number;
  readonly markers?: readonly Marker[];
  readonly bands?: readonly Band[];
  /** Draw as a step line (a state that is on or off). */
  readonly step?: boolean;
}) {
  const span = Math.max(1, toMs - fromMs);
  const vals = points.map((p) => p.v);
  const extra = baseline !== undefined && baseline !== null ? [baseline] : [];
  let lo = Math.min(...vals, ...extra);
  let hi = Math.max(...vals, ...extra);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi - lo < 1e-9) {
    lo -= 0.5;
    hi += 0.5;
  }
  const pad = (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  const x = (t: number) => PAD.l + ((t - fromMs) / span) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  const inWindow = points.filter((p) => p.t >= fromMs && p.t <= toMs);
  let d = "";
  inWindow.forEach((p, i) => {
    if (i === 0) d += `M ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    else if (step) {
      const prev = inWindow[i - 1];
      d += ` L ${x(p.t).toFixed(1)} ${y(prev?.v ?? p.v).toFixed(1)} L ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
    } else d += ` L ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`;
  });
  const last = inWindow.at(-1);
  const summary =
    inWindow.length === 0
      ? `${title}: no data in this window.`
      : `${title}: ${inWindow.length} readings, from ${Math.min(...inWindow.map((p) => p.v)).toFixed(3)} to ${Math.max(...inWindow.map((p) => p.v)).toFixed(3)} ${unit}; latest ${last?.v.toFixed(3) ?? ""} ${unit}.`;
  const tick = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
  return (
    <figure className="chart">
      <figcaption>
        <strong>{title}</strong> <span className="muted">({unit})</span>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} className="chart-svg">
        <title>{summary}</title>
        {bands.map((b) => (
          <g key={b.label}>
            <rect
              x={x(Math.max(fromMs, b.from))}
              y={PAD.t}
              width={Math.max(0, x(Math.min(toMs, b.to)) - x(Math.max(fromMs, b.from)))}
              height={H - PAD.t - PAD.b}
              className="chart-band"
            />
            <text x={x(Math.max(fromMs, b.from)) + 3} y={PAD.t + 10} className="chart-note">
              {b.label}
            </text>
          </g>
        ))}
        <line x1={PAD.l} y1={PAD.t} x2={PAD.l} y2={H - PAD.b} className="chart-axis" />
        <line x1={PAD.l} y1={H - PAD.b} x2={W - PAD.r} y2={H - PAD.b} className="chart-axis" />
        <text x={PAD.l - 4} y={PAD.t + 8} textAnchor="end" className="chart-tick">
          {tick(hi)}
        </text>
        <text x={PAD.l - 4} y={H - PAD.b} textAnchor="end" className="chart-tick">
          {tick(lo)}
        </text>
        {baseline !== undefined && baseline !== null && (
          <g>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={y(baseline)}
              y2={y(baseline)}
              className="chart-baseline"
            />
            <text x={W - PAD.r} y={y(baseline) - 3} textAnchor="end" className="chart-note">
              learned baseline {tick(baseline)}
            </text>
          </g>
        )}
        {d !== "" && <path d={d} className="chart-line" fill="none" />}
        {inWindow.map((p) => (
          <circle
            key={p.t}
            cx={x(p.t)}
            cy={y(p.v)}
            r={inWindow.length > 90 ? 0 : 2}
            className={p.trusted ? "chart-dot" : "chart-dot chart-dot-untrusted"}
          />
        ))}
        {markers
          .filter((m) => m.t >= fromMs && m.t <= toMs)
          .map((m) => (
            <g key={`${m.label}-${m.t}`}>
              <line
                x1={x(m.t)}
                x2={x(m.t)}
                y1={PAD.t}
                y2={H - PAD.b}
                className={`chart-marker chart-marker-${m.tone ?? "info"}`}
              />
              <text x={x(m.t) + 3} y={H - PAD.b - 4} className="chart-note">
                {m.label}
              </text>
            </g>
          ))}
        <text x={PAD.l} y={H - 8} className="chart-tick">
          {new Date(fromMs).toISOString().slice(11, 19)}
        </text>
        <text x={W - PAD.r} y={H - 8} textAnchor="end" className="chart-tick">
          {new Date(toMs).toISOString().slice(11, 19)} UTC
        </text>
      </svg>
    </figure>
  );
}
