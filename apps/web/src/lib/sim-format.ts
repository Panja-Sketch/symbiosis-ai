import type { SensorStatus, SimSensor, WeatherStatus } from "./sim-types";

/** Presentation helpers for the simulation workspace. Display only: no rule or outcome is decided here. */

export const cToF = (c: number): number => (c * 9) / 5 + 32;

export function formatTemperature(c: number): string {
  return `${c.toFixed(1)} °C (${cToF(c).toFixed(0)} °F)`;
}

/** "12 s ago", "3 min ago". The age comes from the server; this only words it. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "no data";
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

export function formatClock(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(11, 19)} UTC`;
}

export function formatSensorValue(s: Pick<SimSensor, "value" | "unit" | "signal">): string {
  if (s.value === null) return "no data";
  if (typeof s.value === "boolean") return s.value ? "Running" : "Stopped";
  if (s.signal === "temperature" || s.signal === "outdoor_temperature")
    return formatTemperature(s.value);
  const digits = s.signal === "vibration_rms" ? 3 : s.signal === "current" ? 2 : 1;
  return `${s.value.toFixed(digits)} ${s.unit}`;
}

export type Tone = "good" | "warn" | "danger" | "info" | "neutral" | "synthetic";

export const SENSOR_STATUS: Readonly<
  Record<SensorStatus, { readonly label: string; readonly icon: string; readonly tone: Tone }>
> = {
  NORMAL: { label: "Normal", icon: "✓", tone: "good" },
  WARNING: { label: "Warning", icon: "▲", tone: "warn" },
  CRITICAL: { label: "Critical", icon: "✕", tone: "danger" },
  LEARNING: { label: "Learning baseline", icon: "◔", tone: "info" },
  NO_DATA: { label: "No recent data", icon: "–", tone: "neutral" },
  UNTRUSTED: { label: "Untrusted data", icon: "!", tone: "synthetic" },
};

export const WEATHER_STATUS: Readonly<
  Record<WeatherStatus, { readonly label: string; readonly tone: Tone; readonly icon: string }>
> = {
  LIVE: { label: "LIVE WEATHER", tone: "good", icon: "●" },
  SIMULATED: { label: "SIMULATED WEATHER", tone: "synthetic", icon: "◇" },
  STALE: { label: "WEATHER STALE", tone: "warn", icon: "▲" },
  UNAVAILABLE: { label: "WEATHER UNAVAILABLE", tone: "danger", icon: "✕" },
  NOT_CONFIGURED: { label: "WEATHER UNAVAILABLE", tone: "danger", icon: "✕" },
};

export const OUTCOME_LABELS: Readonly<Record<string, { label: string; tone: Tone; icon: string }>> =
  {
    NORMAL: { label: "Normal", tone: "good", icon: "✓" },
    WATCH: { label: "Watch: one signal abnormal", tone: "warn", icon: "▲" },
    CANDIDATE_RISK: { label: "Compound condition present", tone: "danger", icon: "✕" },
    INSUFFICIENT_DATA: { label: "Insufficient trusted data", tone: "info", icon: "◔" },
  };

export const DELIVERY_STATUS: Readonly<
  Record<string, { label: string; tone: Tone; icon: string }>
> = {
  SENT: { label: "Sent", tone: "good", icon: "✓" },
  FAILED: { label: "Failed", tone: "danger", icon: "✕" },
  PENDING: { label: "Sending", tone: "info", icon: "…" },
};

export const KIND_LABELS: Readonly<Record<string, string>> = {
  INITIAL: "Alert",
  ESCALATION: "Escalation",
  FOLLOW_UP: "Follow-up",
};

export const SCENARIO_ICONS: Readonly<Record<string, string>> = {
  NORMAL: "✓",
  EMERGING_DETERIORATION: "↗",
  COMPOUND_COOLING_RISK: "⚠",
  INEFFECTIVE_MITIGATION: "↻",
  SUCCESSFUL_MITIGATION: "✔",
  SENSOR_QUALITY_FAILURE: "∅",
  RECURRENCE: "⟲",
};

export const BASELINE_LABEL: Readonly<Record<string, string>> = {
  READY: "Ready",
  LEARNING: "Learning",
  NOT_STARTED: "Not started",
  INSUFFICIENT_DATA: "Insufficient data",
};
