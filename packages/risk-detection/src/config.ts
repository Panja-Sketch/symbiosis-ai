import { CANONICAL_SIGNALS, CASE_SEVERITIES } from "@symbiosis/contracts";
import type { CanonicalSignal, CaseSeverity } from "@symbiosis/contracts";
import { parseTrustPolicy } from "@symbiosis/data-quality";
import type { TrustPolicy } from "@symbiosis/data-quality";

/**
 * Versioned rule configuration (config/rules/cooling-electrical.v1.json). Every threshold and
 * persistence setting comes from here; nothing about the rule is hard-coded in TypeScript.
 */
export type RuleConfig = {
  readonly ruleId: string;
  readonly ruleVersion: string;
  readonly hazardType: string;
  readonly signals: {
    readonly vibration: CanonicalSignal;
    readonly current: CanonicalSignal;
    readonly load: CanonicalSignal;
    readonly zoneTemperature: CanonicalSignal;
    readonly outdoorTemperature: CanonicalSignal;
  };
  readonly thresholds: {
    /** Inclusive: z >= threshold. */
    readonly vibrationZ: number;
    /** Inclusive, positive direction: deviation >= threshold. */
    readonly currentDeviationPercent: number;
    /** Inclusive: outdoor >= threshold. */
    readonly outdoorTemperatureDegF: number;
    /** Exclusive: slope > threshold. */
    readonly zoneTemperatureSlopeDegCPerHour: number;
  };
  readonly zoneSlope: {
    readonly windowSeconds: number;
    readonly minSamples: number;
    readonly minSpanSeconds: number;
  };
  readonly contextMaxAgeSeconds: number;
  readonly persistence: {
    /** Distinct qualifying sample instants required before a risk is detected. */
    readonly minQualifyingEvaluations: number;
    /** A larger gap between qualifying instants restarts the count. */
    readonly maxGapSeconds: number;
  };
  readonly trust: TrustPolicy;
  readonly severity: {
    readonly default: CaseSeverity;
    readonly high: { readonly vibrationZ: number; readonly currentDeviationPercent: number };
    readonly critical: {
      readonly requiresHigh: boolean;
      readonly requiresBothContextBranches: boolean;
    };
  };
};

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function parseRuleConfig(value: unknown): RuleConfig {
  const v = value as RuleConfig | null;
  const signalOk = (s: unknown) => (CANONICAL_SIGNALS as readonly unknown[]).includes(s);
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.ruleId !== "string" ||
    typeof v.ruleVersion !== "string" ||
    typeof v.hazardType !== "string" ||
    !v.signals ||
    ![
      v.signals.vibration,
      v.signals.current,
      v.signals.load,
      v.signals.zoneTemperature,
      v.signals.outdoorTemperature,
    ].every(signalOk) ||
    !v.thresholds ||
    ![
      v.thresholds.vibrationZ,
      v.thresholds.currentDeviationPercent,
      v.thresholds.outdoorTemperatureDegF,
      v.thresholds.zoneTemperatureSlopeDegCPerHour,
    ].every(isNum) ||
    !v.zoneSlope ||
    !(isNum(v.zoneSlope.windowSeconds) && v.zoneSlope.windowSeconds > 0) ||
    !(Number.isInteger(v.zoneSlope.minSamples) && v.zoneSlope.minSamples >= 2) ||
    !(isNum(v.zoneSlope.minSpanSeconds) && v.zoneSlope.minSpanSeconds > 0) ||
    !(isNum(v.contextMaxAgeSeconds) && v.contextMaxAgeSeconds > 0) ||
    !v.persistence ||
    !(
      Number.isInteger(v.persistence.minQualifyingEvaluations) &&
      v.persistence.minQualifyingEvaluations >= 1
    ) ||
    !(isNum(v.persistence.maxGapSeconds) && v.persistence.maxGapSeconds > 0) ||
    !v.severity ||
    !(CASE_SEVERITIES as readonly unknown[]).includes(v.severity.default) ||
    !v.severity.high ||
    !isNum(v.severity.high.vibrationZ) ||
    !isNum(v.severity.high.currentDeviationPercent) ||
    !v.severity.critical ||
    typeof v.severity.critical.requiresHigh !== "boolean" ||
    typeof v.severity.critical.requiresBothContextBranches !== "boolean"
  ) {
    throw new Error("invalid risk rule configuration");
  }
  return { ...v, trust: parseTrustPolicy(v.trust) };
}
