import type { Readings } from "./index";

/**
 * Deterministic detection and post-action scenarios. They only describe what a device would
 * report; every scenario still goes through signing, authentication, normalization and quality
 * like real hardware. A scenario never decides anything: verification is computed from the
 * resulting trusted observations (S5), not from the scenario name.
 */
export const SCENARIOS = [
  "normal",
  "isolated-vibration",
  "isolated-current",
  "context-only",
  "compound-outdoor-heat",
  "compound-rising-temperature",
  /** After maintenance: vibration back within the baseline's tolerance band, but not at target. */
  "partial-improvement",
  /** Healthy readings with the backup equipment observed running. */
  "backup-running",
] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/**
 * @param step zero-based index of the sample within the scenario (drives small deterministic
 * variation, and the temperature ramp for the rising-temperature scenario).
 */
export function scenarioReadings(scenario: ScenarioName, step: number): Readings {
  const normal: Readings = {
    temperature_c: 4.2,
    relative_humidity_pct: 55.1,
    vibration_rms_ms2: 0.18 + ((step % 5) - 2) * 0.002,
    current_ma: 312 + ((step % 3) - 1) * 2,
    fan_a_load_pct: 100,
    chiller_b_running: false,
    outdoor_temperature_c: 30,
  };
  switch (scenario) {
    case "normal":
      return normal;
    case "isolated-vibration":
      return { ...normal, vibration_rms_ms2: 0.35 };
    case "isolated-current":
      return { ...normal, current_ma: 350 };
    case "context-only":
      return { ...normal, outdoor_temperature_c: 42 };
    case "compound-outdoor-heat":
      return { ...normal, vibration_rms_ms2: 0.35, current_ma: 350, outdoor_temperature_c: 42 };
    case "partial-improvement":
      return { ...normal, vibration_rms_ms2: 0.215 };
    case "backup-running":
      return { ...normal, chiller_b_running: true };
    case "compound-rising-temperature":
      return {
        ...normal,
        vibration_rms_ms2: 0.35,
        current_ma: 350,
        temperature_c: Number((4.2 + 0.1 * step).toFixed(2)),
      };
  }
}
