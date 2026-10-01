import {
  CANONICAL_SIGNALS,
  baselineKeyString,
  domainError,
  err,
  isIsoTimestamp,
  isNonEmptyString,
  ok,
} from "@symbiosis/contracts";
import type {
  Baseline,
  BaselineAuditRecord,
  BaselineKey,
  CanonicalSignal,
  DomainError,
  IsoTimestamp,
  Result,
} from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/baselines" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Versioned configuration (config/rules/baselines.v1.json). */
export type BaselineConfig = {
  readonly version: string;
  /** Learning window length, measured in observation time (not wall clock). */
  readonly warmUpSeconds: number;
  /** Fewer trusted observations than this when the window ends => INSUFFICIENT_DATA. */
  readonly minObservations: number;
  /** Numeric signals that get baselines. */
  readonly baselinedSignals: readonly CanonicalSignal[];
  /** Floor for the standard deviation used in z-scores, per signal (avoids division by ~0). */
  readonly stdDevFloor: Readonly<Partial<Record<CanonicalSignal, number>>>;
  readonly operatingModes: {
    readonly loadSignal: CanonicalSignal;
    /** Signals whose baseline depends on the asset's load. */
    readonly modeSensitiveSignals: readonly CanonicalSignal[];
    readonly defaultMode: string;
    /** Ascending by `minInclusive`; the last band whose minimum is <= load wins. */
    readonly bands: readonly { readonly name: string; readonly minInclusive: number }[];
  };
};

export function parseBaselineConfig(value: unknown): BaselineConfig {
  const v = value as Partial<BaselineConfig> | null;
  const signals = (xs: unknown) =>
    Array.isArray(xs) && xs.every((s) => (CANONICAL_SIGNALS as readonly string[]).includes(s));
  const modes = v?.operatingModes;
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.version !== "string" ||
    !(typeof v.warmUpSeconds === "number" && v.warmUpSeconds > 0) ||
    !(Number.isInteger(v.minObservations) && (v.minObservations as number) >= 2) ||
    !signals(v.baselinedSignals) ||
    typeof v.stdDevFloor !== "object" ||
    v.stdDevFloor === null ||
    modes === undefined ||
    !(CANONICAL_SIGNALS as readonly string[]).includes(modes.loadSignal) ||
    !signals(modes.modeSensitiveSignals) ||
    !isNonEmptyString(modes.defaultMode) ||
    !Array.isArray(modes.bands) ||
    modes.bands.some(
      (b, i) =>
        !isNonEmptyString(b.name) ||
        typeof b.minInclusive !== "number" ||
        (i > 0 && b.minInclusive <= (modes.bands[i - 1]?.minInclusive ?? 0)),
    )
  ) {
    throw new Error("invalid baseline configuration");
  }
  return v as BaselineConfig;
}

/**
 * Operating mode for a signal at one instant. Mode-sensitive signals take the band of the
 * asset's load at that instant. `undefined` means the load is present but untrusted, so the
 * mode cannot be established (caller must not learn or evaluate). With no load observation
 * the default mode is used.
 */
export function resolveOperatingMode(
  config: BaselineConfig,
  signal: CanonicalSignal,
  load: { readonly value: number; readonly trusted: boolean } | "ABSENT",
): string | undefined {
  const m = config.operatingModes;
  if (!m.modeSensitiveSignals.includes(signal)) return m.defaultMode;
  if (load === "ABSENT") return m.defaultMode;
  if (!load.trusted) return undefined;
  let name = m.defaultMode;
  for (const band of m.bands) if (load.value >= band.minInclusive) name = band.name;
  return name;
}

export function baselineIdFor(key: BaselineKey, version: number): string {
  return `BSL:${baselineKeyString(key)}:v${version}`;
}

/** A fresh baseline. Learning starts at the first trusted observation, not at creation. */
export function startBaseline(key: BaselineKey, version: number, config: BaselineConfig): Baseline {
  return {
    baselineId: baselineIdFor(key, version),
    key,
    version,
    status: "LEARNING",
    configVersion: config.version,
    observationCount: 0,
    mean: 0,
    m2: 0,
    min: 0,
    max: 0,
  };
}

export type LearnSample = {
  readonly value: number;
  readonly observedAt: IsoTimestamp;
  /** Result of the trust policy; untrusted samples never touch a baseline. */
  readonly trusted: boolean;
};

export type LearnOutcome =
  | "LEARNED"
  | "BECAME_READY"
  | "BECAME_INSUFFICIENT_DATA"
  | "NOT_TRUSTED"
  | "NOT_LEARNING"
  | "DUPLICATE_OR_OUT_OF_ORDER";

/**
 * Adds one observation to a LEARNING baseline (Welford update). The window is measured in
 * observation time from the first trusted sample; when it elapses the baseline becomes READY
 * if it holds at least `minObservations` samples, otherwise INSUFFICIENT_DATA. A baseline that
 * is not LEARNING is frozen, so abnormal behaviour can never silently retrain it.
 */
export function learn(
  baseline: Baseline,
  sample: LearnSample,
  config: BaselineConfig,
): { readonly baseline: Baseline; readonly outcome: LearnOutcome } {
  if (baseline.status !== "LEARNING") return { baseline, outcome: "NOT_LEARNING" };
  if (!sample.trusted || !Number.isFinite(sample.value) || !isIsoTimestamp(sample.observedAt)) {
    return { baseline, outcome: "NOT_TRUSTED" };
  }
  if (
    baseline.lastObservationAt !== undefined &&
    Date.parse(sample.observedAt) <= Date.parse(baseline.lastObservationAt)
  ) {
    return { baseline, outcome: "DUPLICATE_OR_OUT_OF_ORDER" };
  }

  const n = baseline.observationCount + 1;
  const delta = sample.value - baseline.mean;
  const mean = baseline.mean + delta / n;
  const m2 = baseline.m2 + delta * (sample.value - mean);
  const startedAt = baseline.learningStartedAt ?? sample.observedAt;
  let next: Baseline = {
    ...baseline,
    observationCount: n,
    mean,
    m2,
    min: n === 1 ? sample.value : Math.min(baseline.min, sample.value),
    max: n === 1 ? sample.value : Math.max(baseline.max, sample.value),
    learningStartedAt: startedAt,
    lastObservationAt: sample.observedAt,
  };

  const elapsedSeconds = (Date.parse(sample.observedAt) - Date.parse(startedAt)) / 1000;
  if (elapsedSeconds >= config.warmUpSeconds) {
    if (n >= config.minObservations) {
      next = { ...next, status: "READY", readyAt: sample.observedAt };
      return { baseline: next, outcome: "BECAME_READY" };
    }
    next = { ...next, status: "INSUFFICIENT_DATA" };
    return { baseline: next, outcome: "BECAME_INSUFFICIENT_DATA" };
  }
  return { baseline: next, outcome: "LEARNED" };
}

/** Sample standard deviation; 0 until two samples exist. */
export function standardDeviation(baseline: Baseline): number {
  return baseline.observationCount < 2
    ? 0
    : Math.sqrt(baseline.m2 / (baseline.observationCount - 1));
}

/** z-score using max(stddev, configured floor) so near-constant baselines cannot explode. */
export function zScore(baseline: Baseline, value: number, config: BaselineConfig): number {
  const floor = config.stdDevFloor[baseline.key.signal] ?? 0;
  const sd = Math.max(standardDeviation(baseline), floor);
  return sd === 0 ? 0 : (value - baseline.mean) / sd;
}

/** Percent deviation from the baseline mean; undefined when the mean is not positive. */
export function percentDeviation(baseline: Baseline, value: number): number | undefined {
  return baseline.mean > 0 ? ((value - baseline.mean) / baseline.mean) * 100 : undefined;
}

export type RebaselineRequest = {
  readonly actorId: string;
  readonly reason: string;
  readonly at: IsoTimestamp;
};

/**
 * Administrative re-baseline. The active baseline is marked SUPERSEDED (statistics and history
 * preserved) and a new LEARNING version begins. It is only ever triggered by an explicit
 * request carrying an actor and reason; abnormal observations never cause it. Authorization
 * is the caller's responsibility (enforced in a later phase).
 */
export function rebaseline(
  active: Baseline,
  request: RebaselineRequest,
  config: BaselineConfig,
): Result<{ superseded: Baseline; fresh: Baseline; audit: BaselineAuditRecord }, DomainError> {
  if (active.status === "SUPERSEDED") {
    return err(
      domainError("INVALID_INPUT", "BASELINE", "Only an active baseline can be re-baselined", {
        from: active.status,
      }),
    );
  }
  if (
    !isNonEmptyString(request.actorId) ||
    !isNonEmptyString(request.reason) ||
    !isIsoTimestamp(request.at)
  ) {
    return err(
      domainError(
        "INVALID_INPUT",
        "BASELINE",
        "Re-baseline requires an actor, a reason and a time",
      ),
    );
  }
  const fresh = startBaseline(active.key, active.version + 1, config);
  const superseded: Baseline = {
    ...active,
    status: "SUPERSEDED",
    supersededAt: request.at,
    supersededBy: fresh.baselineId,
    supersededFromStatus: active.status,
  };
  return ok({
    superseded,
    fresh,
    audit: {
      action: "REBASELINE",
      key: active.key,
      supersededBaselineId: active.baselineId,
      newBaselineId: fresh.baselineId,
      actorId: request.actorId,
      reason: request.reason,
      at: request.at,
    },
  });
}
