import { BOOLEAN_SIGNALS, CANONICAL_SIGNALS } from "@symbiosis/contracts";
import type {
  CanonicalSignal,
  DeviceHealth,
  ObservationQuality,
  UnassessedObservation,
} from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/data-quality" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Versioned configuration (lives in config/rules/data-quality.v1.json, not in code). */
export type DataQualityConfig = {
  readonly version: string;
  readonly staleAfterSeconds: number;
  readonly futureToleranceSeconds: number;
  readonly staleConfidenceFactor: number;
  readonly unhealthyConfidenceFactor: number;
  /** Plausible physical range per numeric signal, in canonical units. */
  readonly ranges: Readonly<Partial<Record<CanonicalSignal, { min: number; max: number }>>>;
};

export function parseDataQualityConfig(value: unknown): DataQualityConfig {
  const v = value as Partial<DataQualityConfig> | null;
  const fraction = (n: unknown) => typeof n === "number" && n >= 0 && n <= 1;
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.version !== "string" ||
    !positive(v.staleAfterSeconds) ||
    !positive(v.futureToleranceSeconds) ||
    !fraction(v.staleConfidenceFactor) ||
    !fraction(v.unhealthyConfidenceFactor) ||
    typeof v.ranges !== "object" ||
    v.ranges === null
  ) {
    throw new Error("invalid data-quality configuration");
  }
  for (const [signal, range] of Object.entries(v.ranges)) {
    if (
      !(CANONICAL_SIGNALS as readonly string[]).includes(signal) ||
      typeof range?.min !== "number" ||
      typeof range.max !== "number" ||
      range.min > range.max
    ) {
      throw new Error(`invalid data-quality range for ${signal}`);
    }
  }
  return v as DataQualityConfig;
}

export type QualityContext = {
  readonly deviceHealth: DeviceHealth;
  readonly authVerified: boolean;
};

export type QualityAssessment = {
  readonly quality: ObservationQuality;
  /** Human-readable codes explaining every concern; empty when none. */
  readonly reasons: readonly string[];
};

/**
 * Deterministic S2 quality assessment: staleness, physical plausibility, device health and
 * authentication. Missing or questionable data never becomes high-confidence healthy data:
 * UNKNOWN device health counts as unhealthy, and implausible or unauthenticated readings
 * get confidence 0. No baselines, no statistics, no risk logic (S3).
 */
export function assessObservation(
  observation: UnassessedObservation,
  ctx: QualityContext,
  config: DataQualityConfig,
): QualityAssessment {
  const reasons: string[] = [];
  const ageSeconds =
    (Date.parse(observation.receivedAt) - Date.parse(observation.observedAt)) / 1000;

  const stale = !(ageSeconds <= config.staleAfterSeconds);
  if (stale) reasons.push("STALE");
  const inFuture = ageSeconds < -config.futureToleranceSeconds;
  if (inFuture) reasons.push("OBSERVED_IN_FUTURE");

  let outOfRange = false;
  const isBooleanSignal = BOOLEAN_SIGNALS.includes(observation.signal);
  if (typeof observation.value === "boolean") {
    if (!isBooleanSignal) {
      outOfRange = true;
      reasons.push("VALUE_TYPE_MISMATCH");
    }
  } else if (isBooleanSignal || !Number.isFinite(observation.value)) {
    outOfRange = true;
    reasons.push("VALUE_TYPE_MISMATCH");
  } else {
    const range = config.ranges[observation.signal];
    if (range === undefined) {
      outOfRange = true;
      reasons.push("NO_PLAUSIBLE_RANGE_CONFIGURED");
    } else if (observation.value < range.min || observation.value > range.max) {
      outOfRange = true;
      reasons.push("OUT_OF_RANGE");
    }
  }

  const deviceHealthy = ctx.deviceHealth === "HEALTHY";
  if (!deviceHealthy) {
    reasons.push(ctx.deviceHealth === "UNKNOWN" ? "DEVICE_HEALTH_UNKNOWN" : "DEVICE_UNHEALTHY");
  }
  if (!ctx.authVerified) reasons.push("NOT_AUTHENTICATED");

  let confidence = 1;
  if (stale) confidence *= config.staleConfidenceFactor;
  if (!deviceHealthy) confidence *= config.unhealthyConfidenceFactor;
  if (outOfRange || inFuture || !ctx.authVerified) confidence = 0;

  return {
    quality: {
      confidence,
      stale,
      outOfRange,
      deviceHealthy,
      authVerified: ctx.authVerified,
    },
    reasons,
  };
}
