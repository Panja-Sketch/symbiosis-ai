import { createHash } from "node:crypto";
import type { SensorGroup } from "./facility";

/**
 * The simulated physical world (S10, D-091): numbers a building would produce, nothing else. There
 * is no field for a risk, a severity, a case, a verification result or a business outcome, and
 * there never can be: the deterministic platform decides what these numbers mean.
 */
export const SENSOR_HEALTH_VALUES = ["HEALTHY", "DEGRADED", "FAULT"] as const;
export type SensorHealth = (typeof SENSOR_HEALTH_VALUES)[number];

export type SensorCondition = {
  /** Reported by the device's heartbeat. */
  readonly health: SensorHealth;
  /** The device reports readings that are this many seconds old (0 = fresh). */
  readonly staleSeconds: number;
  /** The device sends nothing at all (a missing-data condition). */
  readonly dropout: boolean;
};

export type SimulatedSensorGroup = Exclude<SensorGroup, "weather">;

export type PhysicalValues = {
  readonly zoneTemperatureC: number;
  readonly relativeHumidityPct: number;
  readonly vibrationRmsMs2: number;
  readonly currentA: number;
  readonly loadPercent: number;
  readonly primaryRunning: boolean;
  readonly backupRunning: boolean;
  /** Used only when the weather mode is SIMULATED; live weather never reads it. */
  readonly outdoorTemperatureC: number;
  readonly sensors: Readonly<Record<SimulatedSensorGroup, SensorCondition>>;
};

export type NumericField =
  | "zoneTemperatureC"
  | "relativeHumidityPct"
  | "vibrationRmsMs2"
  | "currentA"
  | "loadPercent"
  | "outdoorTemperatureC";
export type BooleanField = "primaryRunning" | "backupRunning";

export type FieldBound = {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit: string;
  readonly label: string;
};

/** Hard bounds. Nothing outside them is ever accepted, whoever asks. */
export const NUMERIC_BOUNDS: Readonly<Record<NumericField, FieldBound>> = {
  zoneTemperatureC: { min: -30, max: 40, step: 0.1, unit: "degC", label: "Zone temperature" },
  relativeHumidityPct: { min: 0, max: 100, step: 0.5, unit: "%", label: "Zone humidity" },
  vibrationRmsMs2: {
    min: 0,
    max: 20,
    step: 0.01,
    unit: "m/s2",
    label: "Equipment vibration (RMS)",
  },
  currentA: { min: 0, max: 60, step: 0.1, unit: "A", label: "Equipment current" },
  loadPercent: { min: 0, max: 100, step: 1, unit: "%", label: "Equipment load" },
  outdoorTemperatureC: {
    min: -30,
    max: 55,
    step: 0.5,
    unit: "degC",
    label: "Simulated outdoor temperature",
  },
};

export const STALE_SECONDS_MAX = 3600;

export const SENSOR_GROUP_NAMES: Readonly<Record<SimulatedSensorGroup, string>> = {
  hvac: "HVAC Controller",
  vibration: "Vibration Sensor Gateway",
  meter: "Electrical Meter Gateway",
};

export const HEALTHY: SensorCondition = { health: "HEALTHY", staleSeconds: 0, dropout: false };

/** The known-normal world: what a clean reset restores. */
export const NORMAL_VALUES: PhysicalValues = {
  zoneTemperatureC: 4.2,
  relativeHumidityPct: 55,
  vibrationRmsMs2: 0.3,
  currentA: 12,
  loadPercent: 80,
  primaryRunning: true,
  backupRunning: false,
  outdoorTemperatureC: 30,
  sensors: { hvac: HEALTHY, vibration: HEALTHY, meter: HEALTHY },
};

export type SensorPatch = Partial<Record<SimulatedSensorGroup, Partial<SensorCondition>>>;

export type StatePatch = Partial<Omit<PhysicalValues, "sensors">> & { sensors?: SensorPatch };

export type PatchResult =
  | { readonly ok: true; readonly patch: StatePatch }
  | { readonly ok: false; readonly issues: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates an untrusted patch: known keys only, finite numbers inside the hard bounds, real
 * booleans, whole-number staleness. NaN, Infinity, strings, arrays and unknown keys are refused.
 */
export function validateStatePatch(input: unknown): PatchResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["a state change must be an object"] };
  const out: Record<string, unknown> = {};
  const known = new Set<string>([
    ...Object.keys(NUMERIC_BOUNDS),
    "primaryRunning",
    "backupRunning",
    "sensors",
  ]);
  for (const k of Object.keys(input)) if (!known.has(k)) issues.push(`unknown field "${k}"`);

  for (const [field, b] of Object.entries(NUMERIC_BOUNDS)) {
    if (!(field in input)) continue;
    const v = input[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      issues.push(`${b.label} must be a finite number`);
    } else if (v < b.min || v > b.max) {
      issues.push(`${b.label} must be between ${b.min} and ${b.max} ${b.unit}`);
    } else out[field] = v;
  }
  for (const field of ["primaryRunning", "backupRunning"] as const) {
    if (!(field in input)) continue;
    if (typeof input[field] !== "boolean") issues.push(`${field} must be true or false`);
    else out[field] = input[field];
  }
  if ("sensors" in input) {
    const s = input.sensors;
    if (!isRecord(s)) issues.push("sensors must be an object");
    else {
      const sensors: Record<string, Partial<SensorCondition>> = {};
      for (const [group, cond] of Object.entries(s)) {
        if (!(group in SENSOR_GROUP_NAMES)) {
          issues.push(`unknown sensor group "${group}"`);
          continue;
        }
        if (!isRecord(cond)) {
          issues.push(`sensors.${group} must be an object`);
          continue;
        }
        const c: { health?: SensorHealth; staleSeconds?: number; dropout?: boolean } = {};
        for (const k of Object.keys(cond)) {
          if (!["health", "staleSeconds", "dropout"].includes(k))
            issues.push(`unknown field "sensors.${group}.${k}"`);
        }
        if ("health" in cond) {
          if (!(SENSOR_HEALTH_VALUES as readonly unknown[]).includes(cond.health)) {
            issues.push(`sensors.${group}.health must be HEALTHY, DEGRADED or FAULT`);
          } else c.health = cond.health as SensorHealth;
        }
        if ("staleSeconds" in cond) {
          const n = cond.staleSeconds;
          if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > STALE_SECONDS_MAX) {
            issues.push(
              `sensors.${group}.staleSeconds must be a whole number from 0 to ${STALE_SECONDS_MAX}`,
            );
          } else c.staleSeconds = n;
        }
        if ("dropout" in cond) {
          if (typeof cond.dropout !== "boolean")
            issues.push(`sensors.${group}.dropout must be true or false`);
          else c.dropout = cond.dropout;
        }
        sensors[group] = c;
      }
      out.sensors = sensors;
    }
  }
  if (issues.length === 0 && Object.keys(out).length === 0) issues.push("nothing to change");
  return issues.length > 0 ? { ok: false, issues } : { ok: true, patch: out as StatePatch };
}

export function applyPatch(base: PhysicalValues, patch: StatePatch): PhysicalValues {
  const sensors = { ...base.sensors };
  for (const [group, cond] of Object.entries(patch.sensors ?? {})) {
    sensors[group as SimulatedSensorGroup] = {
      ...sensors[group as SimulatedSensorGroup],
      ...cond,
    };
  }
  const { sensors: _ignored, ...rest } = patch;
  return { ...base, ...rest, sensors };
}

/** One recorded change of the world, effective from `atMs`, optionally ramped from the previous values. */
export type StateRevision = {
  readonly sessionId: string;
  readonly revision: number;
  readonly atMs: number;
  readonly values: PhysicalValues;
  /** A physical change that takes this long (a slow deterioration); 0 is a step. */
  readonly rampMs: number;
  /** The values the ramp starts from (the previous revision's effective values at `atMs`). */
  readonly rampFrom?: PhysicalValues;
  readonly setBy: string;
  /** Plain description, e.g. "Scenario COMPOUND_COOLING_RISK" or "Manual: vibration 0.62". */
  readonly note: string;
};

const NUMERIC_FIELDS = Object.keys(NUMERIC_BOUNDS) as NumericField[];

/**
 * The world's values at a moment: the latest revision at or before `ms`, interpolated linearly if
 * that revision is a ramp that has not finished. Booleans and sensor conditions step at `atMs`.
 */
export function valuesAt(history: readonly StateRevision[], ms: number): PhysicalValues {
  let current: StateRevision | undefined;
  for (const r of history)
    if (r.atMs <= ms && (current === undefined || r.revision > current.revision)) current = r;
  if (current === undefined) return NORMAL_VALUES;
  if (
    current.rampMs <= 0 ||
    current.rampFrom === undefined ||
    ms >= current.atMs + current.rampMs
  ) {
    return current.values;
  }
  const f = (ms - current.atMs) / current.rampMs;
  const out: Record<string, number> = {};
  for (const k of NUMERIC_FIELDS) {
    out[k] = round(current.rampFrom[k] + (current.values[k] - current.rampFrom[k]) * f, 4);
  }
  return { ...current.values, ...(out as Pick<PhysicalValues, NumericField>) };
}

export const round = (v: number, digits: number): number => {
  const m = 10 ** digits;
  return Math.round(v * m) / m;
};

/** Deterministic noise in [-1, 1]: the same session, field and instant always give the same number. */
export function noise(seed: string, field: string, instantMs: number): number {
  const h = createHash("sha256").update(`${seed}|${field}|${instantMs}`).digest();
  return (h.readUInt32BE(0) / 0xffffffff) * 2 - 1;
}

/**
 * Whether a world would teach a still-learning baseline a bad habit: a baseline learns whatever it
 * sees, so abnormal readings must not be introduced before it is READY.
 */
export function isAbnormalForBaseline(v: PhysicalValues): boolean {
  return (
    v.vibrationRmsMs2 > NORMAL_VALUES.vibrationRmsMs2 * 1.08 ||
    v.currentA > NORMAL_VALUES.currentA * 1.04 ||
    v.zoneTemperatureC > NORMAL_VALUES.zoneTemperatureC + 0.5 ||
    v.loadPercent < 50 !== NORMAL_VALUES.loadPercent < 50
  );
}
