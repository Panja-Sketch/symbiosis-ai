import type { CanonicalSignal } from "./canonical";
import type { IsoTimestamp } from "./primitives";

export const BASELINE_STATUSES = ["LEARNING", "READY", "INSUFFICIENT_DATA", "SUPERSEDED"] as const;
export type BaselineStatus = (typeof BASELINE_STATUSES)[number];

/** Baseline identity (spec section 17): organization + facility + asset + signal + mode. */
export type BaselineKey = {
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetId: string;
  readonly signal: CanonicalSignal;
  readonly operatingMode: string;
};

export function baselineKeyString(key: BaselineKey): string {
  return [key.organizationId, key.facilityId, key.assetId, key.signal, key.operatingMode].join("|");
}

/**
 * Learned reference for one numeric signal. Statistics are Welford accumulators (count, mean,
 * m2), so mean and standard deviation are exact and deterministic. Only a READY baseline may
 * support a risk conclusion; LEARNING and INSUFFICIENT_DATA never do. A baseline is never
 * overwritten: re-baselining marks it SUPERSEDED and starts a new version.
 */
export type Baseline = {
  readonly baselineId: string;
  readonly key: BaselineKey;
  readonly version: number;
  readonly status: BaselineStatus;
  readonly configVersion: string;

  readonly observationCount: number;
  readonly mean: number;
  /** Sum of squared deviations from the mean (Welford); stddev = sqrt(m2 / (count - 1)). */
  readonly m2: number;
  readonly min: number;
  readonly max: number;

  readonly learningStartedAt?: IsoTimestamp;
  readonly lastObservationAt?: IsoTimestamp;
  readonly readyAt?: IsoTimestamp;

  readonly supersededAt?: IsoTimestamp;
  readonly supersededBy?: string;
  /** Status the baseline had when it was superseded (history is preserved). */
  readonly supersededFromStatus?: Exclude<BaselineStatus, "SUPERSEDED">;
};

/** Immutable set of baselines a detection relied on; referenced by a case. */
export type BaselineSnapshot = {
  readonly snapshotId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly baselineIds: readonly string[];
  readonly createdAt: IsoTimestamp;
};

/** Accountable record of an administrative re-baseline. */
export type BaselineAuditRecord = {
  readonly action: "REBASELINE";
  readonly key: BaselineKey;
  readonly supersededBaselineId: string;
  readonly newBaselineId: string;
  readonly actorId: string;
  readonly reason: string;
  readonly at: IsoTimestamp;
};
