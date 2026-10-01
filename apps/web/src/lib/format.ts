/** Small, deterministic display helpers. No business logic. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "1 Oct 2026, 00:04 UTC". Always UTC so server and browser render the same text. */
export function formatTime(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** Four significant digits, no false precision. */
export function formatValue(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n === 0) return "0";
  return Number(n.toPrecision(4)).toString();
}

export const formatPercent = (n: number | undefined): string =>
  n === undefined ? "—" : `${Math.round(n * 100)}%`;

export const shortHash = (hex: string): string => `${hex.slice(0, 12)}…${hex.slice(-6)}`;

/** `SOME_CODE` -> "some code": a deterministic fallback for codes without a curated phrase. */
export const humanizeCode = (code: string): string => code.toLowerCase().replace(/_/g, " ");
