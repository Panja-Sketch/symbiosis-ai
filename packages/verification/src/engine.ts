import type {
  Baseline,
  CanonicalObservation,
  CriterionOutcome,
  CriterionResult,
  CriterionRole,
  CriterionStat,
  DeviceHealth,
  EvidenceKind,
  EvidenceReference,
  IsoTimestamp,
  MitigationAction,
  RequiredSignal,
  RiskEvent,
  RiskImprovementCase,
  TimeWindow,
  VerificationAssessment,
  VerificationResult,
} from "@symbiosis/contracts";
import { percentDeviation, resolveOperatingMode, zScore } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { assessTrust } from "@symbiosis/data-quality";
import type { PhysicalCriterionPolicy, VerificationPolicy } from "./policy";
import { backupRequired } from "./policy";
import { validateVerificationAssessment } from "./validate";

export const CRITERION_IDS = {
  vibration: "VIBRATION",
  current: "CURRENT",
  backup: "BACKUP_CAPACITY",
  zone: "ZONE_TEMPERATURE_SLOPE",
  dataQuality: "DATA_QUALITY",
  deviceIntegrity: "DEVICE_INTEGRITY",
} as const;

/** Registry-side facts about a device, supplied by the caller (the engine does no I/O). */
export type DeviceFact = {
  readonly deviceId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly status: "ACTIVE" | "DISABLED";
  readonly health: DeviceHealth;
  /** Every asset the device may report for (default asset plus mapping targets). */
  readonly assetIds: readonly string[];
};

export type VerificationInput = {
  readonly verificationId: string;
  readonly policy: VerificationPolicy;
  readonly baselineConfig: BaselineConfig;
  readonly caseRecord: RiskImprovementCase;
  readonly event: RiskEvent;
  /** Reported actions of this verification cycle. */
  readonly actions: readonly MitigationAction[];
  readonly actionReportedAt: IsoTimestamp;
  readonly window: TimeWindow;
  /** Evaluation time. Before `window.end` nothing is concluded. */
  readonly now: IsoTimestamp;
  /** Candidate observations; the engine itself re-applies tenant, asset, signal and window scope. */
  readonly observations: readonly CanonicalObservation[];
  /** Baselines the case relied on (its snapshot), and the currently active baselines. */
  readonly snapshotBaselines: readonly Baseline[];
  readonly activeBaselines: readonly Baseline[];
  readonly devices: readonly DeviceFact[];
  /** Real audit entries (action report, verification start) to reference as evidence. */
  readonly auditEvidenceIds: readonly string[];
};

export type VerificationEvaluation =
  | { readonly complete: false; readonly windowEnd: IsoTimestamp }
  | {
      readonly complete: true;
      readonly assessment: VerificationAssessment;
      readonly evidenceReferences: readonly EvidenceReference[];
      readonly recurrenceWatchEndsAt?: IsoTimestamp;
    };

const INTEGRITY_REASONS = new Set([
  "NOT_AUTHENTICATED",
  "DEVICE_NOT_HEALTHY",
  "DEVICE_NOT_REGISTERED",
  "DEVICE_NOT_ACTIVE",
  "DEVICE_NOT_BOUND_TO_ASSET",
]);
const QUALITY_REASONS = new Set(["STALE", "OUT_OF_RANGE", "LOW_CONFIDENCE", "VALUE_TYPE_MISMATCH"]);

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const ms = (iso: string) => Date.parse(iso);

type Considered = {
  readonly obs: CanonicalObservation;
  readonly t: number;
  /** Empty when the observation may serve as trusted evidence. */
  readonly reasons: readonly string[];
};

type Criterion = CriterionResult & {
  readonly role: CriterionRole;
  readonly outcome: CriterionOutcome;
  readonly reasonCodes: readonly string[];
};

function stat(values: readonly number[]): CriterionStat {
  if (values.length === 0) return { sampleCount: 0 };
  let min = values[0] as number;
  let max = min;
  let sum = 0;
  for (const v of values) {
    sum += v;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  return {
    sampleCount: values.length,
    mean: round4(sum / values.length),
    min: round4(min),
    max: round4(max),
  };
}

/** Largest gap (seconds) between consecutive instants, counting both interval edges. */
function maxGapSeconds(times: readonly number[], from: number, to: number): number {
  if (times.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...times].sort((a, b) => a - b);
  let gap = Math.max(0, (sorted[0] as number) - from);
  for (let i = 1; i < sorted.length; i++) {
    gap = Math.max(gap, (sorted[i] as number) - (sorted[i - 1] as number));
  }
  gap = Math.max(gap, to - (sorted.at(-1) as number));
  return gap / 1000;
}

/** Least-squares slope in value units per hour; undefined when it cannot be computed. */
function slopePerHour(points: readonly { t: number; v: number }[]): number | undefined {
  const n = points.length;
  if (n < 2) return undefined;
  const first = points[0]?.v;
  if (points.every((p) => p.v === first)) return 0;
  const t0 = points[0]?.t ?? 0;
  const xs = points.map((p) => (p.t - t0) / 3_600_000);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = points.reduce((a, p) => a + p.v, 0) / n;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((points[i]?.v ?? 0) - my);
    den += (x - mx) ** 2;
  });
  if (den === 0) return undefined;
  const slope = num / den;
  return Math.abs(slope) < 1e-9 ? 0 : slope;
}

/** The criteria (and assets/signals) a verification of this case cycle must observe. */
export function requiredSignalsFor(
  policy: VerificationPolicy,
  caseRecord: RiskImprovementCase,
  actionLibraryIds: readonly string[],
): RequiredSignal[] {
  const primary = caseRecord.assetIds[0] ?? "";
  const out: RequiredSignal[] = [
    {
      criterionId: CRITERION_IDS.vibration,
      assetId: primary,
      signal: policy.criteria.vibration.signal,
      role: "REQUIRED",
    },
    {
      criterionId: CRITERION_IDS.current,
      assetId: primary,
      signal: policy.criteria.current.signal,
      role: "REQUIRED",
    },
  ];
  if (backupRequired(policy, actionLibraryIds)) {
    for (const assetId of policy.criteria.backupCapacity.assetIds) {
      out.push({
        criterionId: CRITERION_IDS.backup,
        assetId,
        signal: policy.criteria.backupCapacity.signal,
        role: "REQUIRED",
      });
    }
  }
  for (const assetId of policy.criteria.zoneTemperature.assetIds) {
    out.push({
      criterionId: CRITERION_IDS.zone,
      assetId,
      signal: policy.criteria.zoneTemperature.signal,
      role: policy.criteria.zoneTemperature.role,
    });
  }
  return out;
}

/**
 * Deterministic verification of one case/event/action cycle over trusted post-action
 * observations (spec 8, 16). Pure: identical input always yields an identical assessment. No AI,
 * no clock, no network. Nothing about the user's report can make a criterion pass: only trusted
 * sensor observations inside the post-action window count.
 *
 * Criterion outcomes: PASS (trustworthy evidence meets the policy), FAIL (trustworthy evidence
 * does not), INSUFFICIENT (evidence cannot establish either). Result precedence:
 *  1. DEVICE_INTEGRITY insufficient            -> INCONCLUSIVE (untrusted source proves nothing)
 *  2. a physical required criterion trustworthily abnormal, or required backup not observed
 *                                              -> NOT_IMPROVING
 *  3. any other required criterion insufficient -> INCONCLUSIVE
 *  4. required criteria failed only as "improved but not at target" (partial enabled)
 *                                              -> PARTIALLY_VERIFIED (otherwise NOT_IMPROVING)
 *  5. every required criterion passed          -> VERIFIED
 * A VERIFIED assessment must additionally pass the structural validator, otherwise it becomes
 * INCONCLUSIVE.
 */
export function evaluateVerification(input: VerificationInput): VerificationEvaluation {
  const { policy, caseRecord, window } = input;
  const windowStart = ms(window.start);
  const windowEnd = ms(window.end);
  if (!(ms(input.now) >= windowEnd)) return { complete: false, windowEnd: window.end };

  const primary = caseRecord.assetIds[0] ?? "";
  const actionLibraryIds = [...new Set(input.actions.map((a) => a.actionLibraryId))];
  const needBackup = backupRequired(policy, actionLibraryIds);
  const zoneRole = policy.criteria.zoneTemperature.role;
  const loadSignal = input.baselineConfig.operatingModes.loadSignal;

  // ---- scope + classification --------------------------------------------------------------
  const relevantAssets = new Set<string>([
    primary,
    ...(needBackup ? policy.criteria.backupCapacity.assetIds : []),
    ...policy.criteria.zoneTemperature.assetIds,
  ]);
  const deviceById = new Map(
    input.devices
      .filter(
        (d) =>
          d.organizationId === caseRecord.organizationId && d.facilityId === caseRecord.facilityId,
      )
      .map((d) => [d.deviceId, d] as const),
  );
  const trustPolicy = {
    minConfidence: policy.integrity.minObservationConfidence,
    requireHealthyDevice: true,
  };
  const numericSignals = new Set<string>([
    policy.criteria.vibration.signal,
    policy.criteria.current.signal,
    policy.criteria.zoneTemperature.signal,
    loadSignal,
  ]);

  const classify = (o: CanonicalObservation): Considered => {
    const reasons = [...assessTrust(o.quality, trustPolicy).reasons];
    const device = deviceById.get(o.deviceId);
    if (device === undefined) reasons.push("DEVICE_NOT_REGISTERED");
    else {
      if (device.status !== "ACTIVE") reasons.push("DEVICE_NOT_ACTIVE");
      if (!device.assetIds.includes(o.assetId)) reasons.push("DEVICE_NOT_BOUND_TO_ASSET");
    }
    const wantsNumber = numericSignals.has(o.signal);
    if (wantsNumber ? typeof o.value !== "number" : typeof o.value !== "boolean") {
      reasons.push("VALUE_TYPE_MISMATCH");
    }
    return { obs: o, t: ms(o.observedAt), reasons };
  };

  // Tenant, facility and asset scope is enforced here, whatever the caller passed in.
  const scoped: Considered[] = input.observations
    .filter(
      (o) =>
        o.organizationId === caseRecord.organizationId &&
        o.facilityId === caseRecord.facilityId &&
        relevantAssets.has(o.assetId),
    )
    .map(classify)
    .sort((a, b) => a.t - b.t);

  const loadAt = new Map<string, Considered>();
  for (const c of scoped) {
    if (c.obs.signal === loadSignal) loadAt.set(`${c.obs.assetId}|${c.obs.observedAt}`, c);
  }
  const inWindow = (c: Considered) => c.t >= windowStart && c.t <= windowEnd;
  const series = (assetId: string, signal: string) =>
    scoped.filter((c) => c.obs.assetId === assetId && c.obs.signal === signal && inWindow(c));
  const trustedOf = (list: readonly Considered[]) => list.filter((c) => c.reasons.length === 0);

  const sustainStart = windowEnd - policy.sustained.seconds * 1000;
  const evidenceObservationIds = new Set<string>();
  const usedBaselineIds = new Set<string>();
  const markConsidered = (list: readonly Considered[]) => {
    for (const c of list) evidenceObservationIds.add(c.obs.observationId);
  };

  // ---- baselines ---------------------------------------------------------------------------
  const pickBaseline = (assetId: string, signal: string, mode: string): Baseline | undefined => {
    const matches = (b: Baseline) =>
      b.key.organizationId === caseRecord.organizationId &&
      b.key.facilityId === caseRecord.facilityId &&
      b.key.assetId === assetId &&
      b.key.signal === signal &&
      b.key.operatingMode === mode;
    const fromSnapshot = input.snapshotBaselines.find(
      (b) => matches(b) && (b.status === "READY" || b.supersededFromStatus === "READY"),
    );
    if (fromSnapshot !== undefined) return fromSnapshot;
    return input.activeBaselines.find((b) => matches(b) && b.status === "READY");
  };

  // ---- physical criteria (vibration, current) ----------------------------------------------
  const physical = (
    criterionId: string,
    crit: PhysicalCriterionPolicy,
    assetId: string,
  ): Criterion => {
    const all = series(assetId, crit.signal);
    markConsidered(all);
    const trusted = trustedOf(all);
    const reasons: string[] = [];
    const excluded = new Map<string, number>();
    for (const c of all) for (const r of c.reasons) excluded.set(r, (excluded.get(r) ?? 0) + 1);

    type Usable = { t: number; value: number; metric: number; baseline: Baseline; mode: string };
    const usable: Usable[] = [];
    for (const c of trusted) {
      const value = c.obs.value as number;
      const loadC = loadAt.get(`${assetId}|${c.obs.observedAt}`);
      const load =
        loadC === undefined
          ? ("ABSENT" as const)
          : {
              value: typeof loadC.obs.value === "number" ? loadC.obs.value : Number.NaN,
              trusted: loadC.reasons.length === 0 && typeof loadC.obs.value === "number",
            };
      const mode = resolveOperatingMode(input.baselineConfig, crit.signal, load);
      if (mode === undefined) {
        excluded.set("OPERATING_MODE_UNKNOWN", (excluded.get("OPERATING_MODE_UNKNOWN") ?? 0) + 1);
        continue;
      }
      const baseline = pickBaseline(assetId, crit.signal, mode);
      if (baseline === undefined) {
        const k = `NO_BASELINE_FOR_MODE:${mode}`;
        excluded.set(k, (excluded.get(k) ?? 0) + 1);
        continue;
      }
      const metric =
        crit.metric === "z_score"
          ? zScore(baseline, value, input.baselineConfig)
          : percentDeviation(baseline, value);
      if (metric === undefined) {
        excluded.set(
          "BASELINE_MEAN_NOT_POSITIVE",
          (excluded.get("BASELINE_MEAN_NOT_POSITIVE") ?? 0) + 1,
        );
        continue;
      }
      usable.push({ t: c.t, value, metric, baseline, mode });
    }

    // informational "before": trusted raw values in the pre-action lookback window
    const reportedMs = ms(input.actionReportedAt);
    const beforeFrom = reportedMs - policy.reference.preActionLookbackSeconds * 1000;
    const before = stat(
      scoped
        .filter(
          (c) =>
            c.obs.assetId === assetId &&
            c.obs.signal === crit.signal &&
            c.reasons.length === 0 &&
            c.t >= beforeFrom &&
            c.t < reportedMs &&
            typeof c.obs.value === "number",
        )
        .map((c) => c.obs.value as number),
    );

    const tail = usable.filter((u) => u.t >= sustainStart);
    const tailBaselines = [
      ...new Map(tail.map((u) => [u.baseline.baselineId, u.baseline])).values(),
    ];
    for (const u of usable) usedBaselineIds.add(u.baseline.baselineId);
    const thresholds = {
      targetMax: crit.targetMax,
      abnormalMin: crit.abnormalMin,
      passFraction: crit.passFraction,
      partialMaxAbnormalFraction: crit.partialMaxAbnormalFraction,
    };
    const base = {
      criterionId,
      role: crit.role,
      assetId,
      signal: crit.signal,
      metric: crit.metric,
      thresholds,
      before,
      observed: stat(tail.map((u) => u.value)),
      observedMetric: stat(tail.map((u) => u.metric)),
      reference: {
        baselineIds: tailBaselines.map((b) => b.baselineId).sort(),
        operatingModes: [...new Set(tail.map((u) => u.mode))].sort(),
        ...(tailBaselines.length === 1 && { mean: round4((tailBaselines[0] as Baseline).mean) }),
      },
      evidenceIds: all.map((c) => c.obs.observationId),
    };
    const done = (outcome: CriterionOutcome, codes: readonly string[]): Criterion => {
      const exclusionCodes =
        outcome === "PASS"
          ? []
          : [...excluded.entries()].sort().map(([r, n]) => `EXCLUDED_${r}:${n}`);
      return {
        ...base,
        passed: outcome === "PASS",
        outcome,
        reasonCodes: [...codes, ...exclusionCodes],
      };
    };

    if (all.length === 0 || trusted.length === 0) {
      reasons.push(all.length === 0 ? "REQUIRED_SIGNAL_MISSING" : "NO_TRUSTED_OBSERVATIONS");
      return done("INSUFFICIENT", reasons);
    }
    if (usable.length === 0) return done("INSUFFICIENT", ["NO_USABLE_OBSERVATIONS_FOR_BASELINE"]);
    if (usable.length < policy.minObservations) {
      return done("INSUFFICIENT", ["INSUFFICIENT_OBSERVATIONS"]);
    }
    if (tail.length < policy.sustained.minObservations) {
      return done("INSUFFICIENT", ["INSUFFICIENT_OBSERVATIONS_IN_SUSTAINED_INTERVAL"]);
    }
    if (
      maxGapSeconds(
        tail.map((u) => u.t),
        sustainStart,
        windowEnd,
      ) > policy.acceptableMissingness.maxGapSeconds
    ) {
      return done("INSUFFICIENT", ["GAP_IN_SUSTAINED_INTERVAL"]);
    }
    const targetFraction = tail.filter((u) => u.metric <= crit.targetMax).length / tail.length;
    const abnormalFraction = tail.filter((u) => u.metric >= crit.abnormalMin).length / tail.length;
    if (targetFraction >= crit.passFraction) return done("PASS", ["SUSTAINED_WITHIN_TARGET"]);
    return done(
      "FAIL",
      abnormalFraction > crit.partialMaxAbnormalFraction
        ? ["STILL_MATERIALLY_ABNORMAL"]
        : ["IMPROVED_BUT_NOT_AT_TARGET"],
    );
  };

  const vibration = physical(CRITERION_IDS.vibration, policy.criteria.vibration, primary);
  const current = physical(CRITERION_IDS.current, policy.criteria.current, primary);

  // ---- backup capacity (only when the reported action path requires it) --------------------
  let backup: Criterion | undefined;
  if (needBackup) {
    const cfg = policy.criteria.backupCapacity;
    const perAsset = cfg.assetIds.map((assetId) => {
      const all = series(assetId, cfg.signal);
      markConsidered(all);
      const trusted = trustedOf(all).filter((c) => typeof c.obs.value === "boolean");
      const tail = trusted.filter((c) => c.t >= sustainStart);
      const running = tail.filter((c) => c.obs.value === true).length;
      let outcome: CriterionOutcome;
      let codes: string[];
      if (all.length === 0) {
        outcome = "INSUFFICIENT";
        codes = ["REQUIRED_SIGNAL_MISSING"];
      } else if (
        tail.length < policy.sustained.minObservations ||
        maxGapSeconds(
          tail.map((c) => c.t),
          sustainStart,
          windowEnd,
        ) > policy.acceptableMissingness.maxGapSeconds
      ) {
        outcome = "INSUFFICIENT";
        codes = ["INSUFFICIENT_OBSERVATIONS_IN_SUSTAINED_INTERVAL"];
      } else if (running / tail.length >= cfg.passFraction) {
        outcome = "PASS";
        codes = ["BACKUP_OBSERVED_RUNNING"];
      } else {
        outcome = "FAIL";
        codes = ["BACKUP_NOT_OBSERVED_RUNNING"];
      }
      return { assetId, all, tail, running, outcome, codes };
    });
    const best =
      perAsset.find((p) => p.outcome === "PASS") ??
      perAsset.find((p) => p.outcome === "FAIL") ??
      (perAsset[0] as (typeof perAsset)[number]);
    backup = {
      criterionId: CRITERION_IDS.backup,
      role: "REQUIRED",
      passed: best.outcome === "PASS",
      outcome: best.outcome,
      assetId: best.assetId,
      signal: cfg.signal,
      metric: "running_fraction",
      thresholds: { passFraction: cfg.passFraction },
      observed: {
        sampleCount: best.tail.length,
        ...(best.tail.length > 0 && { mean: round4(best.running / best.tail.length) }),
      },
      reasonCodes: best.codes,
      evidenceIds: best.all.map((c) => c.obs.observationId),
    };
  }

  // ---- zone temperature slope (role from policy) -------------------------------------------
  const zoneCfg = policy.criteria.zoneTemperature;
  const zoneAssets = zoneCfg.assetIds.map((assetId) => {
    const all = series(assetId, zoneCfg.signal);
    markConsidered(all);
    const pts = trustedOf(all)
      .filter((c) => typeof c.obs.value === "number")
      .map((c) => ({ t: c.t, v: c.obs.value as number }));
    const span = pts.length > 1 ? ((pts.at(-1)?.t ?? 0) - (pts[0]?.t ?? 0)) / 1000 : 0;
    const enough = pts.length >= zoneCfg.minSamples && span >= zoneCfg.minSpanSeconds;
    const slope = enough ? slopePerHour(pts) : undefined;
    return { assetId, all, pts, slope };
  });
  const measured = zoneAssets.filter((z) => z.slope !== undefined);
  const zoneOutcome: CriterionOutcome =
    measured.length === 0
      ? "INSUFFICIENT"
      : measured.every((z) => (z.slope as number) <= zoneCfg.maxSlopeDegCPerHour)
        ? "PASS"
        : "FAIL";
  const worst = measured.reduce<number | undefined>(
    (acc, z) => (acc === undefined ? z.slope : Math.max(acc, z.slope as number)),
    undefined,
  );
  const zone: Criterion = {
    criterionId: CRITERION_IDS.zone,
    role: zoneRole,
    passed: zoneOutcome === "PASS",
    outcome: zoneOutcome,
    signal: zoneCfg.signal,
    metric: "slope_deg_c_per_hour",
    thresholds: { maxSlopeDegCPerHour: zoneCfg.maxSlopeDegCPerHour },
    observed: {
      sampleCount: zoneAssets.reduce((n, z) => n + z.pts.length, 0),
      ...(worst !== undefined && { mean: round4(worst) }),
    },
    reasonCodes:
      zoneOutcome === "PASS"
        ? ["ZONE_TEMPERATURE_STABLE_OR_FALLING"]
        : zoneOutcome === "FAIL"
          ? ["ZONE_TEMPERATURE_RISING"]
          : ["ZONE_TEMPERATURE_INSUFFICIENT_SAMPLES"],
    evidenceIds: zoneAssets.flatMap((z) => z.all.map((c) => c.obs.observationId)),
  };

  // ---- data quality (required) --------------------------------------------------------------
  const expected =
    Math.floor((windowEnd - windowStart) / 1000 / policy.sampling.expectedIntervalSeconds) + 1;
  type SeriesCheck = { label: string; list: Considered[] };
  const checks: SeriesCheck[] = [
    { label: CRITERION_IDS.vibration, list: series(primary, policy.criteria.vibration.signal) },
    { label: CRITERION_IDS.current, list: series(primary, policy.criteria.current.signal) },
  ];
  if (needBackup) {
    const cfg = policy.criteria.backupCapacity;
    const lists = cfg.assetIds.map((a) => series(a, cfg.signal));
    const bestList = lists.reduce((a, b) => (trustedOf(b).length > trustedOf(a).length ? b : a));
    checks.push({ label: CRITERION_IDS.backup, list: bestList });
  }
  if (zoneRole === "REQUIRED") {
    checks.push({
      label: CRITERION_IDS.zone,
      list: zoneAssets.flatMap((z) => z.all).sort((a, b) => a.t - b.t),
    });
  }
  const dqCodes: string[] = [];
  const ratios: number[] = [];
  const confidences: number[] = [];
  for (const { label, list } of checks) {
    const trusted = trustedOf(list);
    const ratio = Math.min(1, trusted.length / expected);
    ratios.push(trusted.length === 0 ? 0 : ratio);
    const meanConfidence =
      trusted.length === 0
        ? 0
        : trusted.reduce((s, c) => s + c.obs.quality.confidence, 0) / trusted.length;
    confidences.push(meanConfidence);
    const counts = new Map<string, number>();
    for (const c of list) for (const r of c.reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
    const qualityExcluded = list.filter((c) =>
      c.reasons.some((r) => QUALITY_REASONS.has(r)),
    ).length;
    if (list.length === 0) dqCodes.push(`${label}:REQUIRED_SIGNAL_MISSING`);
    else if (trusted.length === 0) dqCodes.push(`${label}:NO_TRUSTED_OBSERVATIONS`);
    if (trusted.length > 0 && trusted.length < policy.minObservations) {
      dqCodes.push(`${label}:INSUFFICIENT_OBSERVATIONS`);
    }
    if (trusted.length > 0 && 1 - ratio > policy.acceptableMissingness.maxMissingFraction) {
      dqCodes.push(`${label}:MISSINGNESS_EXCEEDS_LIMIT`);
    }
    if (
      trusted.length > 0 &&
      maxGapSeconds(
        trusted.map((c) => c.t),
        windowStart,
        windowEnd,
      ) > policy.acceptableMissingness.maxGapSeconds
    ) {
      dqCodes.push(`${label}:MISSING_INTERVAL_EXCEEDS_LIMIT`);
    }
    if (list.length > 0 && qualityExcluded / list.length > policy.integrity.maxUntrustedFraction) {
      dqCodes.push(`${label}:UNTRUSTED_DATA_FRACTION_EXCEEDED`);
    }
    if ((counts.get("STALE") ?? 0) > 0 && trusted.length < policy.minObservations) {
      dqCodes.push(`${label}:STALE_REQUIRED_TELEMETRY`);
    }
    if (trusted.length > 0 && meanConfidence < policy.minTelemetryConfidence) {
      dqCodes.push(`${label}:LOW_TELEMETRY_CONFIDENCE`);
    }
  }
  const completeness = round4(ratios.length === 0 ? 0 : Math.min(...ratios));
  const telemetryConfidence = round4(confidences.length === 0 ? 0 : Math.min(...confidences));
  const dataQuality: Criterion = {
    criterionId: CRITERION_IDS.dataQuality,
    role: "REQUIRED",
    passed: dqCodes.length === 0,
    outcome: dqCodes.length === 0 ? "PASS" : "INSUFFICIENT",
    metric: "completeness",
    thresholds: {
      minObservations: policy.minObservations,
      maxMissingFraction: policy.acceptableMissingness.maxMissingFraction,
      maxGapSeconds: policy.acceptableMissingness.maxGapSeconds,
      minTelemetryConfidence: policy.minTelemetryConfidence,
    },
    observed: {
      sampleCount: checks.reduce((n, c) => n + trustedOf(c.list).length, 0),
      mean: completeness,
    },
    reasonCodes: dqCodes.length === 0 ? ["DATA_COMPLETE_AND_FRESH"] : dqCodes,
    evidenceIds: checks.flatMap((c) => c.list.map((x) => x.obs.observationId)),
  };

  // ---- device integrity (required) ----------------------------------------------------------
  const requiredAssets = new Set<string>([
    primary,
    ...(needBackup ? policy.criteria.backupCapacity.assetIds : []),
  ]);
  if (zoneRole === "REQUIRED")
    for (const a of policy.criteria.zoneTemperature.assetIds) requiredAssets.add(a);
  const expectedDevices = [...deviceById.values()].filter((d) =>
    d.assetIds.some((a) => requiredAssets.has(a)),
  );
  const integrityCodes: string[] = [];
  const requiredScoped = checks.flatMap((c) => c.list);
  const unauthenticated = requiredScoped.filter((c) => c.reasons.includes("NOT_AUTHENTICATED"));
  if (unauthenticated.length > 0) integrityCodes.push("UNAUTHENTICATED_EVIDENCE_PRESENT");
  if (expectedDevices.length === 0) integrityCodes.push("NO_REGISTERED_DEVICE_FOR_REQUIRED_ASSET");
  for (const d of expectedDevices) {
    if (d.status !== "ACTIVE") integrityCodes.push(`DEVICE_NOT_ACTIVE:${d.deviceId}`);
    if (d.health !== policy.integrity.requiredDeviceHealth) {
      integrityCodes.push(`DEVICE_NOT_HEALTHY:${d.deviceId}`);
    }
  }
  const integrityExcluded = requiredScoped.filter((c) =>
    c.reasons.some((r) => INTEGRITY_REASONS.has(r) && r !== "NOT_AUTHENTICATED"),
  ).length;
  if (
    requiredScoped.length > 0 &&
    integrityExcluded / requiredScoped.length > policy.integrity.maxUntrustedFraction
  ) {
    integrityCodes.push("UNHEALTHY_OR_UNBOUND_DEVICE_DATA_EXCEEDS_LIMIT");
  }
  const integrity: Criterion = {
    criterionId: CRITERION_IDS.deviceIntegrity,
    role: "REQUIRED",
    passed: integrityCodes.length === 0,
    outcome: integrityCodes.length === 0 ? "PASS" : "INSUFFICIENT",
    metric: "integrity",
    thresholds: { maxUntrustedFraction: policy.integrity.maxUntrustedFraction },
    observed: { sampleCount: requiredScoped.length },
    reasonCodes:
      integrityCodes.length === 0 ? ["DEVICES_HEALTHY_AND_AUTHENTICATED"] : integrityCodes,
    evidenceIds: expectedDevices.map((d) => `DEVICE:${d.deviceId}`),
  };

  // ---- decision ------------------------------------------------------------------------------
  const all: Criterion[] = [
    vibration,
    current,
    ...(backup !== undefined ? [backup] : []),
    zone,
    dataQuality,
    integrity,
  ];
  const required = all.filter((c) => c.role === "REQUIRED");
  const supporting = all.filter((c) => c.role === "SUPPORTING");
  const physicalRequired = required.filter(
    (c) =>
      c.criterionId !== CRITERION_IDS.dataQuality &&
      c.criterionId !== CRITERION_IDS.deviceIntegrity,
  );

  let result: VerificationResult;
  let headline: string;
  if (integrity.outcome === "INSUFFICIENT") {
    result = "INCONCLUSIVE";
    headline = "EVIDENCE_UNTRUSTED_OR_DEVICE_INTEGRITY_NOT_ESTABLISHED";
  } else if (
    physicalRequired.some(
      (c) =>
        c.outcome === "FAIL" &&
        (c.reasonCodes.includes("STILL_MATERIALLY_ABNORMAL") ||
          c.reasonCodes.includes("BACKUP_NOT_OBSERVED_RUNNING") ||
          c.reasonCodes.includes("ZONE_TEMPERATURE_RISING")),
    )
  ) {
    result = "NOT_IMPROVING";
    headline = "TRUSTED_EVIDENCE_SHOWS_NO_IMPROVEMENT";
  } else if (required.some((c) => c.outcome === "INSUFFICIENT")) {
    result = "INCONCLUSIVE";
    headline = "EVIDENCE_INSUFFICIENT_TO_ESTABLISH_OUTCOME";
  } else if (required.some((c) => c.outcome === "FAIL")) {
    // every remaining failure is "improved but not at target"
    result = policy.partial.enabled ? "PARTIALLY_VERIFIED" : "NOT_IMPROVING";
    headline = policy.partial.enabled
      ? "PARTIAL_IMPROVEMENT_NOT_AT_TARGET"
      : "SUSTAINED_IMPROVEMENT_TARGET_NOT_MET";
  } else {
    result = "VERIFIED";
    headline = "ALL_REQUIRED_CRITERIA_PASSED";
  }

  // ---- evidence ------------------------------------------------------------------------------
  const refs = new Map<string, EvidenceKind>();
  const addRef = (id: string, kind: EvidenceKind) => refs.set(id, kind);
  for (const id of evidenceObservationIds) addRef(id, "OBSERVATION");
  for (const id of usedBaselineIds) addRef(id, "BASELINE");
  for (const a of input.actions) addRef(a.actionId, "ACTION");
  for (const id of input.auditEvidenceIds) addRef(id, "AUDIT");
  addRef(`POLICY:${policy.policyId}:${policy.policyVersion}`, "POLICY");
  for (const d of expectedDevices) addRef(`DEVICE:${d.deviceId}`, "DEVICE");

  // ---- assembly ------------------------------------------------------------------------------
  const baselineStarts = [...usedBaselineIds].flatMap((id) => {
    const b = [...input.snapshotBaselines, ...input.activeBaselines].find(
      (x) => x.baselineId === id,
    );
    return b?.learningStartedAt !== undefined && b.readyAt !== undefined
      ? [{ s: ms(b.learningStartedAt), e: ms(b.readyAt) }]
      : [];
  });
  const reportedMs = ms(input.actionReportedAt);
  let baselineWindow: TimeWindow = {
    start: new Date(reportedMs - policy.reference.preActionLookbackSeconds * 1000).toISOString(),
    end: new Date(reportedMs).toISOString(),
  };
  if (baselineStarts.length > 0) {
    const s = Math.min(...baselineStarts.map((b) => b.s));
    const e = Math.max(...baselineStarts.map((b) => b.e));
    if (s < e)
      baselineWindow = { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
  }
  const reasonCodes = [
    headline,
    ...all.flatMap((c) =>
      c.outcome === "PASS" ? [] : c.reasonCodes.map((r) => `${c.criterionId}:${r}`),
    ),
  ];
  const trustedCount = checks.reduce((n, c) => n + trustedOf(c.list).length, 0);
  const deviceHealthStatus =
    expectedDevices.length === 0
      ? "UNKNOWN"
      : expectedDevices.every((d) => d.status === "ACTIVE" && d.health === "HEALTHY")
        ? "HEALTHY"
        : "NOT_HEALTHY";
  const authIntegrityStatus =
    unauthenticated.length > 0
      ? "UNAUTHENTICATED_EVIDENCE_PRESENT"
      : trustedCount === 0
        ? "NO_EVIDENCE"
        : "VERIFIED";

  const assessment: VerificationAssessment = {
    verificationId: input.verificationId,
    caseId: caseRecord.caseId,
    eventId: input.event.eventId,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    baselineWindow,
    postActionWindow: window,
    requiredCriteria: required,
    supportingCriteria: supporting,
    dataCompleteness: completeness,
    telemetryConfidence,
    deviceHealthStatus,
    authIntegrityStatus,
    result,
    confidence: round4(completeness * telemetryConfidence),
    evidenceIds: [...refs.keys()].sort(),
    evaluatedAt: input.now,
    reasonCodes,
  };

  // Last line of defense: a VERIFIED result that is not self-consistent is never emitted.
  let final = assessment;
  if (result === "VERIFIED" && !validateVerificationAssessment(assessment).ok) {
    final = {
      ...assessment,
      result: "INCONCLUSIVE",
      reasonCodes: ["ASSESSMENT_FAILED_VALIDATION", ...reasonCodes.slice(1)],
    };
  }
  const evidenceReferences = [...refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, kind]) => ({ id, kind }));
  return {
    complete: true,
    assessment: final,
    evidenceReferences,
    ...(final.result === "VERIFIED" && {
      recurrenceWatchEndsAt: new Date(
        windowEnd + policy.recurrenceWatch.seconds * 1000,
      ).toISOString(),
    }),
  };
}
