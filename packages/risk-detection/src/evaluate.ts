import { baselineKeyString } from "@symbiosis/contracts";
import type {
  Baseline,
  BaselineKey,
  BaselineStatus,
  CanonicalObservation,
  CaseSeverity,
  DetectionFact as Fact,
  DetectionPersistence as Persistence,
  DetectionSample as Sample,
  DetectionState,
  EvaluationMetrics,
  EvaluationOutcome,
  ObservationEvaluation,
  RiskDetection,
} from "@symbiosis/contracts";
import {
  learn,
  percentDeviation,
  resolveOperatingMode,
  startBaseline,
  zScore,
} from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { assessTrust } from "@symbiosis/data-quality";
import type { RuleConfig } from "./config";

export function detectionStateKey(organizationId: string, facilityId: string, ruleId: string) {
  return `${organizationId}|${facilityId}|${ruleId}`;
}

export function emptyDetectionState(
  organizationId: string,
  facilityId: string,
  ruleId: string,
): DetectionState {
  return {
    stateKey: detectionStateKey(organizationId, facilityId, ruleId),
    organizationId,
    facilityId,
    ruleId,
    facts: {},
    zoneSamples: {},
    persistence: {},
  };
}

export type BaselineBook = Readonly<Record<string, Baseline>>;

export type EvaluateInput = {
  readonly organizationId: string;
  readonly facilityId: string;
  /** Observations of one quality-assessed event. */
  readonly observations: readonly CanonicalObservation[];
  readonly state: DetectionState;
  /** Active baselines keyed by baselineKeyString. */
  readonly baselines: BaselineBook;
  readonly rule: RuleConfig;
  readonly baselineConfig: BaselineConfig;
};

export type EvaluateOutput = {
  readonly state: DetectionState;
  readonly baselines: BaselineBook;
  readonly changedBaselines: readonly Baseline[];
  readonly evaluations: readonly ObservationEvaluation[];
  readonly detections: readonly RiskDetection[];
};

type BaselineInfo = {
  readonly mode?: string;
  /** READY baseline available for evaluation before this observation was considered. */
  readonly evalBaseline?: Baseline;
  readonly statusBefore?: BaselineStatus | "NOT_STARTED";
  readonly current?: Baseline;
};

type Analysis = {
  readonly observation?: CanonicalObservation;
  readonly insufficient: boolean;
  readonly reasons: string[];
  readonly abnormal: boolean;
  readonly metric?: number;
};

const toF = (c: number) => (c * 9) / 5 + 32;

/** Slopes smaller than this are floating-point noise, not a trend (units: degC per hour). */
const SLOPE_NOISE_FLOOR = 1e-9;

function slopePerHour(samples: readonly Sample[]): number | undefined {
  const n = samples.length;
  if (n < 2) return undefined;
  const first = samples[0]?.v;
  if (samples.every((s) => s.v === first)) return 0; // exactly flat: no rounding noise
  const t0 = samples[0]?.t ?? 0;
  const xs = samples.map((s) => (s.t - t0) / 3_600_000);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = samples.reduce((a, s) => a + s.v, 0) / n;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * ((samples[i]?.v ?? 0) - my);
    den += (x - mx) ** 2;
  });
  if (den === 0) return undefined;
  const slope = num / den;
  return Math.abs(slope) < SLOPE_NOISE_FLOOR ? 0 : slope;
}

function severityFor(
  rule: RuleConfig,
  vibrationZ: number,
  deviation: number,
  heat: boolean,
  rising: boolean,
): CaseSeverity {
  const s = rule.severity;
  const high = vibrationZ >= s.high.vibrationZ && deviation >= s.high.currentDeviationPercent;
  const { requiresHigh, requiresBothContextBranches } = s.critical;
  const criticalConfigured = requiresHigh || requiresBothContextBranches;
  const critical =
    criticalConfigured &&
    (!requiresHigh || high) &&
    (!requiresBothContextBranches || (heat && rising));
  if (critical) return "CRITICAL";
  return high ? "HIGH" : s.default;
}

/**
 * Deterministic baseline learning + compound-risk evaluation for one quality-assessed event.
 *
 * Per sample instant (all readings sharing an observed_at): (1) every observation becomes a
 * fact, trusted or not; (2) baselines learn from trusted samples until READY, and a frozen
 * READY baseline is what later samples are compared with; (3) the rule is evaluated per
 * primary asset: vibration z-score AND current deviation AND (outdoor heat OR rising zone
 * temperature). Missing, untrusted or baseline-less inputs yield INSUFFICIENT_DATA, never
 * NORMAL. A single abnormal signal is at most WATCH. The compound condition must persist over
 * `minQualifyingEvaluations` distinct instants before a detection is produced.
 */
export function evaluateSample(input: EvaluateInput): EvaluateOutput {
  const { rule, baselineConfig } = input;
  const facts: Record<string, Fact> = { ...input.state.facts };
  const zoneSamples: Record<string, Sample[]> = {};
  for (const [k, v] of Object.entries(input.state.zoneSamples)) zoneSamples[k] = [...v];
  const persistence: Record<string, Persistence> = { ...input.state.persistence };
  const book: Record<string, Baseline> = { ...input.baselines };
  const changed = new Map<string, Baseline>();
  const evaluations: ObservationEvaluation[] = [];
  const detections: RiskDetection[] = [];

  const byInstant = new Map<string, CanonicalObservation[]>();
  for (const o of input.observations) {
    const list = byInstant.get(o.observedAt) ?? [];
    list.push(o);
    byInstant.set(o.observedAt, list);
  }
  const instants = [...byInstant.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));

  for (const at of instants) {
    const atMs = Date.parse(at);
    const obs = byInstant.get(at) ?? [];

    // 1. facts
    for (const o of obs) {
      const trust = assessTrust(o.quality, rule.trust);
      const key = `${o.assetId}|${o.signal}`;
      const prior = facts[key];
      if (prior === undefined || Date.parse(prior.observedAt) <= atMs) {
        facts[key] = {
          observationId: o.observationId,
          assetId: o.assetId,
          signal: o.signal,
          value: o.value,
          unit: o.unit,
          observedAt: at,
          trusted: trust.trusted,
          trustReasons: trust.reasons,
          confidence: o.quality.confidence,
        };
      }
      if (
        o.signal === rule.signals.zoneTemperature &&
        trust.trusted &&
        typeof o.value === "number"
      ) {
        const list = (zoneSamples[o.assetId] ??= []);
        if (!list.some((s) => s.t === atMs)) list.push({ t: atMs, v: o.value });
        zoneSamples[o.assetId] = list
          .filter((s) => s.t >= atMs - rule.zoneSlope.windowSeconds * 1000)
          .sort((a, b) => a.t - b.t);
      }
    }

    // 1b. Same-instant siblings (S10, D-088). The primary signals of one asset may be reported by
    // DIFFERENT gateways, so they can arrive in different events. A primary reading that is not in
    // this event but is already a stored fact with exactly this instant belongs to the same sample.
    // It is used only to complete the sample: it is never re-learned (a baseline refuses an
    // observation at or before its last one) and never emits an evaluation of its own.
    const siblings: CanonicalObservation[] = [];
    const eventAssets = new Set(
      obs
        .filter((o) => o.signal === rule.signals.vibration || o.signal === rule.signals.current)
        .map((o) => o.assetId),
    );
    for (const assetId of eventAssets) {
      for (const signal of [rule.signals.vibration, rule.signals.current]) {
        if (obs.some((o) => o.assetId === assetId && o.signal === signal)) continue;
        const f = facts[`${assetId}|${signal}`];
        if (f === undefined || f.observedAt !== at) continue;
        siblings.push({
          observationId: f.observationId,
          organizationId: input.organizationId,
          facilityId: input.facilityId,
          assetId,
          deviceId: "SAME-INSTANT-FACT",
          signal: f.signal as CanonicalObservation["signal"],
          value: f.value,
          unit: f.unit,
          observedAt: at,
          receivedAt: at,
          sourceType: "SIMULATOR",
          sourceAdapter: "same-instant-fact",
          quality: {
            confidence: f.confidence,
            stale: false,
            outOfRange: false,
            deviceHealthy: f.trusted,
            authVerified: f.trusted,
          },
        });
      }
    }

    // 2. baselines
    const info = new Map<string, BaselineInfo>();
    for (const o of [...obs, ...siblings]) {
      if (typeof o.value !== "number" || !baselineConfig.baselinedSignals.includes(o.signal))
        continue;
      const loadFact = facts[`${o.assetId}|${baselineConfig.operatingModes.loadSignal}`];
      const load =
        loadFact !== undefined && loadFact.observedAt === at && typeof loadFact.value === "number"
          ? { value: loadFact.value, trusted: loadFact.trusted }
          : ("ABSENT" as const);
      const mode = resolveOperatingMode(baselineConfig, o.signal, load);
      if (mode === undefined) {
        info.set(o.observationId, {});
        continue;
      }
      const key: BaselineKey = {
        organizationId: o.organizationId,
        facilityId: o.facilityId,
        assetId: o.assetId,
        signal: o.signal,
        operatingMode: mode,
      };
      const ks = baselineKeyString(key);
      const existing = book[ks];
      const fact = facts[`${o.assetId}|${o.signal}`];
      const statusBefore: BaselineStatus | "NOT_STARTED" = existing?.status ?? "NOT_STARTED";
      const evalBaseline = existing?.status === "READY" ? existing : undefined;
      let current = existing;
      if (existing === undefined || existing.status === "LEARNING") {
        const learned = learn(
          existing ?? startBaseline(key, 1, baselineConfig),
          { value: o.value, observedAt: at, trusted: fact?.trusted ?? false },
          baselineConfig,
        );
        if (learned.outcome !== "NOT_TRUSTED" && learned.outcome !== "DUPLICATE_OR_OUT_OF_ORDER") {
          book[ks] = learned.baseline;
          changed.set(learned.baseline.baselineId, learned.baseline);
          current = learned.baseline;
        }
      }
      info.set(o.observationId, {
        mode,
        statusBefore,
        ...(evalBaseline !== undefined && { evalBaseline }),
        ...(current !== undefined && { current }),
      });
    }

    // 3. rule per primary asset
    const sig = rule.signals;
    const primaryAssets = [
      ...new Set(
        obs
          .filter((o) => o.signal === sig.vibration || o.signal === sig.current)
          .map((o) => o.assetId),
      ),
    ].sort();

    const analyze = (
      label: string,
      o: CanonicalObservation | undefined,
      kind: "z" | "pct",
    ): Analysis => {
      if (o === undefined)
        return { insufficient: true, reasons: [`${label}_MISSING`], abnormal: false };
      const fact = facts[`${o.assetId}|${o.signal}`];
      if (fact === undefined || !fact.trusted) {
        const why = (fact?.trustReasons ?? []).map((r) => `${label}_NOT_TRUSTED:${r}`);
        return {
          observation: o,
          insufficient: true,
          reasons: why.length > 0 ? why : [`${label}_NOT_TRUSTED`],
          abnormal: false,
        };
      }
      if (typeof o.value !== "number") {
        return {
          observation: o,
          insufficient: true,
          reasons: [`${label}_NOT_NUMERIC`],
          abnormal: false,
        };
      }
      const bi = info.get(o.observationId);
      if (bi === undefined || bi.mode === undefined) {
        return {
          observation: o,
          insufficient: true,
          reasons: [`${label}_OPERATING_MODE_UNKNOWN`],
          abnormal: false,
        };
      }
      const baseline = bi.evalBaseline;
      if (baseline === undefined) {
        return {
          observation: o,
          insufficient: true,
          reasons: [`BASELINE_${bi.statusBefore ?? "NOT_STARTED"}:${label}`],
          abnormal: false,
        };
      }
      if (kind === "z") {
        const z = zScore(baseline, o.value, baselineConfig);
        return {
          observation: o,
          insufficient: false,
          reasons: [],
          abnormal: z >= rule.thresholds.vibrationZ,
          metric: z,
        };
      }
      const dev = percentDeviation(baseline, o.value);
      if (dev === undefined) {
        return {
          observation: o,
          insufficient: true,
          reasons: [`${label}_BASELINE_MEAN_NOT_POSITIVE`],
          abnormal: false,
        };
      }
      return {
        observation: o,
        insufficient: false,
        reasons: [],
        abnormal: dev >= rule.thresholds.currentDeviationPercent,
        metric: dev,
      };
    };

    // facility-level context (shared by all primary assets at this instant)
    let outdoorF: number | undefined;
    let outdoorObs: Fact | undefined;
    for (const f of Object.values(facts)) {
      if (
        f.signal === sig.outdoorTemperature &&
        f.trusted &&
        typeof f.value === "number" &&
        f.unit === "degC" &&
        atMs - Date.parse(f.observedAt) <= rule.contextMaxAgeSeconds * 1000 &&
        Date.parse(f.observedAt) <= atMs &&
        (outdoorObs === undefined || f.observedAt > outdoorObs.observedAt)
      ) {
        outdoorObs = f;
        outdoorF = toF(f.value);
      }
    }
    const heat = outdoorF !== undefined && outdoorF >= rule.thresholds.outdoorTemperatureDegF;
    const risingZones: { assetId: string; slope: number }[] = [];
    let maxSlope: number | undefined;
    let slopeKnown = false;
    for (const [assetId, samples] of Object.entries(zoneSamples)) {
      const inWindow = samples.filter((s) => s.t >= atMs - rule.zoneSlope.windowSeconds * 1000);
      const span =
        inWindow.length > 1 ? ((inWindow.at(-1)?.t ?? 0) - (inWindow[0]?.t ?? 0)) / 1000 : 0;
      if (inWindow.length < rule.zoneSlope.minSamples || span < rule.zoneSlope.minSpanSeconds)
        continue;
      const slope = slopePerHour(inWindow);
      if (slope === undefined) continue;
      slopeKnown = true;
      maxSlope = maxSlope === undefined ? slope : Math.max(maxSlope, slope);
      if (slope > rule.thresholds.zoneTemperatureSlopeDegCPerHour)
        risingZones.push({ assetId, slope });
    }
    const rising = risingZones.length > 0;
    const contextKnown = outdoorF !== undefined || slopeKnown;

    primaryAssets.forEach((assetId, index) => {
      const vibObs =
        obs.find((o) => o.assetId === assetId && o.signal === sig.vibration) ??
        siblings.find((o) => o.assetId === assetId && o.signal === sig.vibration);
      const curObs =
        obs.find((o) => o.assetId === assetId && o.signal === sig.current) ??
        siblings.find((o) => o.assetId === assetId && o.signal === sig.current);
      const vib = analyze("VIBRATION", vibObs, "z");
      const cur = analyze("CURRENT", curObs, "pct");

      const instantReasons: string[] = [];
      let instant: EvaluationOutcome;
      if (vib.insufficient || cur.insufficient) {
        instant = "INSUFFICIENT_DATA";
        instantReasons.push(...vib.reasons, ...cur.reasons);
      } else if (vib.abnormal && cur.abnormal && (heat || rising)) {
        instant = "CANDIDATE_RISK";
        instantReasons.push(
          "VIBRATION_Z_AT_OR_ABOVE_THRESHOLD",
          "CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD",
        );
        if (heat) instantReasons.push("OUTDOOR_HEAT_CONTEXT");
        if (rising) instantReasons.push("ZONE_TEMPERATURE_RISING");
      } else if (vib.abnormal || cur.abnormal) {
        instant = "WATCH";
        if (vib.abnormal) instantReasons.push("VIBRATION_ABNORMAL");
        if (cur.abnormal) instantReasons.push("CURRENT_ABNORMAL");
        instantReasons.push(
          vib.abnormal && cur.abnormal
            ? contextKnown
              ? "CONTEXT_NOT_SATISFIED"
              : "CONTEXT_NOT_ESTABLISHED"
            : "SINGLE_SIGNAL_ABNORMAL",
        );
      } else {
        instant = "NORMAL";
        instantReasons.push(heat || rising ? "CONTEXT_ONLY" : "WITHIN_BASELINE");
      }

      // persistence (distinct sample instants only)
      const p = persistence[assetId] ?? { streak: 0 };
      let counted = false;
      let nextP: Persistence = p;
      if (instant === "CANDIDATE_RISK") {
        if (p.lastCountedAt !== at) {
          const gapOk =
            p.streak > 0 &&
            p.lastQualifyingAt !== undefined &&
            (atMs - Date.parse(p.lastQualifyingAt)) / 1000 <= rule.persistence.maxGapSeconds;
          nextP = { streak: gapOk ? p.streak + 1 : 1, lastQualifyingAt: at, lastCountedAt: at };
          counted = true;
        }
      } else if (instant === "NORMAL" || instant === "WATCH") {
        nextP = { ...p, streak: 0 };
      }
      persistence[assetId] = nextP;

      const metrics: EvaluationMetrics = {
        ...(vib.metric !== undefined && { vibrationZ: vib.metric }),
        ...(cur.metric !== undefined && { currentDeviationPercent: cur.metric }),
        ...(outdoorF !== undefined && { outdoorTemperatureDegF: outdoorF }),
        ...(maxSlope !== undefined && { zoneTemperatureSlopeDegCPerHour: maxSlope }),
      };
      const persistenceInfo = {
        qualifyingEvaluations: nextP.streak,
        required: rule.persistence.minQualifyingEvaluations,
      };

      // per-observation evaluations
      const considered = obs.filter(
        (o) =>
          (o.assetId === assetId && (o.signal === sig.vibration || o.signal === sig.current)) ||
          (index === 0 &&
            (o.signal === sig.zoneTemperature || o.signal === sig.outdoorTemperature)),
      );
      for (const o of considered) {
        const isPrimary = o.signal === sig.vibration || o.signal === sig.current;
        const analysis = o.signal === sig.vibration ? vib : cur;
        let outcome: EvaluationOutcome;
        let reasons: string[];
        if (isPrimary) {
          if (analysis.insufficient) {
            outcome = "INSUFFICIENT_DATA";
            reasons = analysis.reasons;
          } else if (analysis.abnormal) {
            outcome = instant === "CANDIDATE_RISK" ? "CANDIDATE_RISK" : "WATCH";
            reasons = instantReasons;
          } else {
            outcome = "NORMAL";
            reasons = ["WITHIN_BASELINE"];
          }
        } else {
          const fact = facts[`${o.assetId}|${o.signal}`];
          const satisfies =
            o.signal === sig.outdoorTemperature
              ? heat && outdoorObs?.assetId === o.assetId
              : risingZones.some((z) => z.assetId === o.assetId);
          if (fact === undefined || !fact.trusted) {
            outcome = "INSUFFICIENT_DATA";
            reasons = (fact?.trustReasons ?? []).map((r) => `CONTEXT_NOT_TRUSTED:${r}`);
          } else if (instant === "CANDIDATE_RISK" && satisfies) {
            outcome = "CANDIDATE_RISK";
            reasons = [
              o.signal === sig.outdoorTemperature
                ? "OUTDOOR_HEAT_CONTEXT"
                : "ZONE_TEMPERATURE_RISING",
            ];
          } else {
            outcome = "NORMAL";
            reasons = ["CONTEXT_OBSERVED"];
          }
        }
        const bi = info.get(o.observationId);
        const ref = bi?.evalBaseline ?? bi?.current;
        evaluations.push({
          observationId: o.observationId,
          assetId: o.assetId,
          signal: o.signal,
          observedAt: at,
          outcome,
          instantOutcome: instant,
          reasonCodes: [...new Set(reasons)],
          ruleId: rule.ruleId,
          ruleVersion: rule.ruleVersion,
          ...(ref !== undefined &&
            bi?.mode !== undefined && {
              baseline: { baselineId: ref.baselineId, status: ref.status, operatingMode: bi.mode },
            }),
          metrics,
          persistence: persistenceInfo,
        });
      }

      if (
        counted &&
        instant === "CANDIDATE_RISK" &&
        vib.observation &&
        cur.observation &&
        nextP.streak >= rule.persistence.minQualifyingEvaluations
      ) {
        const vf = facts[`${assetId}|${sig.vibration}`];
        const cf = facts[`${assetId}|${sig.current}`];
        const baselineIds = [
          info.get(vib.observation.observationId)?.evalBaseline?.baselineId,
          info.get(cur.observation.observationId)?.evalBaseline?.baselineId,
        ].filter((x): x is string => x !== undefined);
        const supporting = [vib.observation.observationId, cur.observation.observationId];
        if (heat && outdoorObs) supporting.push(outdoorObs.observationId);
        const contextAssets = new Set<string>();
        if (heat && outdoorObs) contextAssets.add(outdoorObs.assetId);
        for (const z of risingZones) {
          contextAssets.add(z.assetId);
          const zf = facts[`${z.assetId}|${sig.zoneTemperature}`];
          if (zf) supporting.push(zf.observationId);
        }
        contextAssets.delete(assetId);
        detections.push({
          detectionId: `DET-${rule.ruleId}-${assetId}-${at}`,
          organizationId: input.organizationId,
          facilityId: input.facilityId,
          ruleId: rule.ruleId,
          ruleVersion: rule.ruleVersion,
          hazardType: rule.hazardType,
          primaryAssetId: assetId,
          contextAssetIds: [...contextAssets].sort(),
          severity: severityFor(rule, vib.metric ?? 0, cur.metric ?? 0, heat, rising),
          confidence: Math.min(vf?.confidence ?? 0, cf?.confidence ?? 0),
          detectedAt: at,
          reasonCodes: [
            ...instantReasons,
            `PERSISTED_${nextP.streak}_OF_${rule.persistence.minQualifyingEvaluations}`,
          ],
          supportingObservationIds: [...new Set(supporting)],
          baselineIds,
          persistence: persistenceInfo,
          metrics,
        });
      }
    });
  }

  return {
    state: { ...input.state, facts, zoneSamples, persistence },
    baselines: book,
    changedBaselines: [...changed.values()],
    evaluations,
    detections,
  };
}
