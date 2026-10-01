import { CANONICAL_SIGNALS, CRITERION_ROLES } from "@symbiosis/contracts";
import type { CanonicalSignal, CriterionRole } from "@symbiosis/contracts";

/** Schema identifier of the policy files this build understands. Anything else fails closed. */
export const VERIFICATION_POLICY_SCHEMA = "verification-policy.v1" as const;

export type PhysicalCriterionPolicy = {
  /** Vibration and current must be REQUIRED in policy v1. */
  readonly role: CriterionRole;
  readonly signal: CanonicalSignal;
  /** z-score (against baseline stddev/floor) or signed percent deviation from the baseline mean. */
  readonly metric: "z_score" | "percent_deviation";
  /** An observation meets the target when its metric is <= this (inclusive). */
  readonly targetMax: number;
  /** An observation is materially abnormal when its metric is >= this (inclusive). The band between
   * `targetMax` and `abnormalMin` is the hysteresis/tolerance zone: neither success nor failure. */
  readonly abnormalMin: number;
  /** Share of sustained-interval samples that must meet the target for PASS. */
  readonly passFraction: number;
  /** More abnormal samples than this share means "still materially abnormal" (not partial). */
  readonly partialMaxAbnormalFraction: number;
};

export type VerificationPolicy = {
  readonly schema: typeof VERIFICATION_POLICY_SCHEMA;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly hazardType: string;
  readonly reference: {
    readonly source: "CASE_SNAPSHOT_THEN_ACTIVE_SAME_MODE";
    /** Length of the pre-action window used for the informational "before" values. */
    readonly preActionLookbackSeconds: number;
  };
  readonly postActionWindow: {
    /** Observations before `reportedAt + settleSeconds` are ignored (work still in progress). */
    readonly settleSeconds: number;
    readonly durationSeconds: number;
  };
  readonly sampling: { readonly expectedIntervalSeconds: number };
  /** Trusted samples a required signal needs across the window. */
  readonly minObservations: number;
  readonly acceptableMissingness: {
    readonly maxMissingFraction: number;
    readonly maxGapSeconds: number;
  };
  /** The trailing part of the window that must show the improvement. */
  readonly sustained: { readonly seconds: number; readonly minObservations: number };
  readonly integrity: {
    readonly requireAuthenticated: true;
    readonly requiredDeviceHealth: "HEALTHY";
    readonly minObservationConfidence: number;
    readonly maxUntrustedFraction: number;
  };
  readonly minTelemetryConfidence: number;
  readonly criteria: {
    readonly vibration: PhysicalCriterionPolicy;
    readonly current: PhysicalCriterionPolicy;
    readonly backupCapacity: {
      readonly signal: CanonicalSignal;
      readonly assetIds: readonly string[];
      /** Backup capacity is required only when one of these approved actions was reported. */
      readonly requiredForActionLibraryIds: readonly string[];
      readonly passFraction: number;
    };
    readonly zoneTemperature: {
      readonly role: CriterionRole;
      readonly signal: CanonicalSignal;
      readonly assetIds: readonly string[];
      /** Stable or falling: slope must be <= this (degC per hour). */
      readonly maxSlopeDegCPerHour: number;
      readonly minSamples: number;
      readonly minSpanSeconds: number;
    };
  };
  readonly partial: { readonly enabled: boolean };
  readonly recurrenceWatch: { readonly seconds: number };
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPositive = (v: unknown): v is number => isNum(v) && v > 0;
const isFraction = (v: unknown): v is number => isNum(v) && v >= 0 && v <= 1;
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isSignal = (v: unknown): v is CanonicalSignal =>
  (CANONICAL_SIGNALS as readonly unknown[]).includes(v);
const isRole = (v: unknown): v is CriterionRole =>
  (CRITERION_ROLES as readonly unknown[]).includes(v);
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

function parsePhysical(name: string, v: unknown): PhysicalCriterionPolicy {
  if (!isRecord(v)) throw new Error(`invalid verification policy: criteria.${name} is missing`);
  if (v.role !== "REQUIRED") {
    throw new Error(`invalid verification policy: criteria.${name} must be REQUIRED`);
  }
  if (
    !isSignal(v.signal) ||
    (v.metric !== "z_score" && v.metric !== "percent_deviation") ||
    !isNum(v.targetMax) ||
    !isNum(v.abnormalMin) ||
    !(v.abnormalMin > v.targetMax) ||
    !isFraction(v.passFraction) ||
    !(v.passFraction > 0) ||
    !isFraction(v.partialMaxAbnormalFraction)
  ) {
    throw new Error(`invalid verification policy: criteria.${name}`);
  }
  return {
    role: "REQUIRED",
    signal: v.signal,
    metric: v.metric,
    targetMax: v.targetMax,
    abnormalMin: v.abnormalMin,
    passFraction: v.passFraction,
    partialMaxAbnormalFraction: v.partialMaxAbnormalFraction,
  };
}

/**
 * Parses and validates a verification policy. Every failure throws: a malformed, partial or
 * unsupported policy can never be used, so it can never lead to VERIFIED. Weakening the
 * authentication or device-health requirements is not supported in policy v1 and is rejected.
 */
export function parseVerificationPolicy(value: unknown): VerificationPolicy {
  if (!isRecord(value)) throw new Error("invalid verification policy: not an object");
  if (value.schema !== VERIFICATION_POLICY_SCHEMA) {
    throw new Error(`unsupported verification policy schema: ${String(value.schema)}`);
  }
  const { reference, postActionWindow, sampling, acceptableMissingness, sustained, integrity } =
    value;
  const { criteria, partial, recurrenceWatch } = value;
  if (
    !isText(value.policyId) ||
    !isText(value.policyVersion) ||
    !isText(value.hazardType) ||
    !isRecord(reference) ||
    reference.source !== "CASE_SNAPSHOT_THEN_ACTIVE_SAME_MODE" ||
    !isPositive(reference.preActionLookbackSeconds) ||
    !isRecord(postActionWindow) ||
    !(isNum(postActionWindow.settleSeconds) && postActionWindow.settleSeconds >= 0) ||
    !isPositive(postActionWindow.durationSeconds) ||
    !isRecord(sampling) ||
    !isPositive(sampling.expectedIntervalSeconds) ||
    !(Number.isInteger(value.minObservations) && (value.minObservations as number) >= 1) ||
    !isRecord(acceptableMissingness) ||
    !isFraction(acceptableMissingness.maxMissingFraction) ||
    !isPositive(acceptableMissingness.maxGapSeconds) ||
    !isRecord(sustained) ||
    !isPositive(sustained.seconds) ||
    !(Number.isInteger(sustained.minObservations) && (sustained.minObservations as number) >= 1) ||
    !isRecord(integrity) ||
    integrity.requireAuthenticated !== true ||
    integrity.requiredDeviceHealth !== "HEALTHY" ||
    !isFraction(integrity.minObservationConfidence) ||
    !isFraction(integrity.maxUntrustedFraction) ||
    !isFraction(value.minTelemetryConfidence) ||
    !isRecord(criteria) ||
    !isRecord(partial) ||
    typeof partial.enabled !== "boolean" ||
    !isRecord(recurrenceWatch) ||
    !isPositive(recurrenceWatch.seconds)
  ) {
    throw new Error("invalid verification policy");
  }
  if ((sustained.seconds as number) > (postActionWindow.durationSeconds as number)) {
    throw new Error("invalid verification policy: sustained interval exceeds the window");
  }
  const backup = criteria.backupCapacity;
  const zone = criteria.zoneTemperature;
  if (
    !isRecord(backup) ||
    !isSignal(backup.signal) ||
    !isIdList(backup.assetIds) ||
    backup.assetIds.length === 0 ||
    !isIdList(backup.requiredForActionLibraryIds) ||
    !isFraction(backup.passFraction) ||
    !(backup.passFraction > 0) ||
    !isRecord(zone) ||
    !isRole(zone.role) ||
    !isSignal(zone.signal) ||
    !isIdList(zone.assetIds) ||
    zone.assetIds.length === 0 ||
    !isNum(zone.maxSlopeDegCPerHour) ||
    !(Number.isInteger(zone.minSamples) && (zone.minSamples as number) >= 2) ||
    !isPositive(zone.minSpanSeconds)
  ) {
    throw new Error("invalid verification policy: backupCapacity or zoneTemperature");
  }
  return {
    schema: VERIFICATION_POLICY_SCHEMA,
    policyId: value.policyId,
    policyVersion: value.policyVersion,
    hazardType: value.hazardType,
    reference: {
      source: "CASE_SNAPSHOT_THEN_ACTIVE_SAME_MODE",
      preActionLookbackSeconds: reference.preActionLookbackSeconds,
    },
    postActionWindow: {
      settleSeconds: postActionWindow.settleSeconds as number,
      durationSeconds: postActionWindow.durationSeconds,
    },
    sampling: { expectedIntervalSeconds: sampling.expectedIntervalSeconds },
    minObservations: value.minObservations as number,
    acceptableMissingness: {
      maxMissingFraction: acceptableMissingness.maxMissingFraction,
      maxGapSeconds: acceptableMissingness.maxGapSeconds,
    },
    sustained: {
      seconds: sustained.seconds,
      minObservations: sustained.minObservations as number,
    },
    integrity: {
      requireAuthenticated: true,
      requiredDeviceHealth: "HEALTHY",
      minObservationConfidence: integrity.minObservationConfidence,
      maxUntrustedFraction: integrity.maxUntrustedFraction,
    },
    minTelemetryConfidence: value.minTelemetryConfidence,
    criteria: {
      vibration: parsePhysical("vibration", criteria.vibration),
      current: parsePhysical("current", criteria.current),
      backupCapacity: {
        signal: backup.signal,
        assetIds: [...backup.assetIds],
        requiredForActionLibraryIds: [...backup.requiredForActionLibraryIds],
        passFraction: backup.passFraction,
      },
      zoneTemperature: {
        role: zone.role,
        signal: zone.signal,
        assetIds: [...zone.assetIds],
        maxSlopeDegCPerHour: zone.maxSlopeDegCPerHour,
        minSamples: zone.minSamples as number,
        minSpanSeconds: zone.minSpanSeconds,
      },
    },
    partial: { enabled: partial.enabled },
    recurrenceWatch: { seconds: recurrenceWatch.seconds },
  };
}

/** Post-action window for a cycle whose latest action was reported at `reportedAtMs`. */
export function postActionWindowFor(
  policy: VerificationPolicy,
  reportedAtIso: string,
): { readonly start: string; readonly end: string } {
  const start = Date.parse(reportedAtIso) + policy.postActionWindow.settleSeconds * 1000;
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + policy.postActionWindow.durationSeconds * 1000).toISOString(),
  };
}

/** True when the approved action requires observing backup capacity (spec 16). */
export function backupRequired(
  policy: VerificationPolicy,
  actionLibraryIds: readonly string[],
): boolean {
  return actionLibraryIds.some((id) =>
    policy.criteria.backupCapacity.requiredForActionLibraryIds.includes(id),
  );
}
