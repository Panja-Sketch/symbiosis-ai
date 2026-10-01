import { INTERVENTION_LEVELS } from "@symbiosis/contracts";
import type {
  AuditEntry,
  InterventionFacts,
  InterventionLevel,
  RiskImprovementCase,
  VerificationAttempt,
} from "@symbiosis/contracts";
import type { Condition, InterventionPolicy } from "./policy";

export type PolicyDecision = {
  readonly level: InterventionLevel;
  /** Reason codes of every matching rule (or the default), in policy order. */
  readonly reasonCodes: readonly string[];
  readonly matchedRuleIds: readonly string[];
};

function holds(c: Condition, facts: InterventionFacts): boolean {
  const actual = facts[c.fact] as string | number | boolean;
  switch (c.op) {
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "gte":
      return typeof actual === "number" && typeof c.value === "number" && actual >= c.value;
    case "lte":
      return typeof actual === "number" && typeof c.value === "number" && actual <= c.value;
    case "gt":
      return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
    case "lt":
      return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
  }
}

/**
 * Deterministic prioritization: every rule whose conditions all hold contributes its reason
 * code; the level is the highest among matching rules (so the order of rules cannot change the
 * outcome); with no match the policy default applies. No AI, no randomness, no clock.
 */
export function evaluateInterventionPolicy(
  policy: InterventionPolicy,
  facts: InterventionFacts,
): PolicyDecision {
  const matched = policy.rules.filter((r) => r.when.every((c) => holds(c, facts)));
  if (matched.length === 0) {
    return {
      level: policy.default.level,
      reasonCodes: [policy.default.reasonCode],
      matchedRuleIds: [],
    };
  }
  const rank = (l: InterventionLevel) => INTERVENTION_LEVELS.indexOf(l);
  const level = matched.reduce<InterventionLevel>(
    (best, r) => (rank(r.level) > rank(best) ? r.level : best),
    matched[0]?.level ?? policy.default.level,
  );
  return {
    level,
    reasonCodes: [...new Set(matched.map((r) => r.reasonCode))],
    matchedRuleIds: matched.map((r) => r.ruleId),
  };
}

const CORROBORATING = new Set([
  "VIBRATION_Z_AT_OR_ABOVE_THRESHOLD",
  "CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD",
  "OUTDOOR_HEAT_CONTEXT",
  "ZONE_TEMPERATURE_RISING",
]);

export type FactsBundle = {
  readonly facts: InterventionFacts;
  /** Real records the facts came from (verifications, audit entries). */
  readonly supportingEvidenceIds: readonly string[];
  readonly dataSufficiency: number;
};

/**
 * Collects the trusted facts the policy may use from persisted records only: the case, its
 * completed verification attempts and its audit trail. Missing evidence is never converted into
 * confidence: with no verification and no detection record, data sufficiency is 0.
 */
export function buildInterventionFacts(input: {
  readonly policy: InterventionPolicy;
  readonly caseRecord: RiskImprovementCase;
  readonly attempts: readonly VerificationAttempt[];
  readonly audit: readonly AuditEntry[];
}): FactsBundle {
  const { caseRecord: c } = input;
  const completed = input.attempts
    .filter((a) => a.status === "COMPLETED" && a.assessment !== undefined)
    .sort((a, b) => Date.parse(a.evaluatedAt ?? "") - Date.parse(b.evaluatedAt ?? ""));
  const results = completed.map((a) => a.assessment?.result ?? "INCONCLUSIVE");
  const latest = completed.at(-1);
  const latestResult = results.at(-1) ?? "NONE";
  let consecutive = 0;
  for (let i = results.length - 1; i >= 0 && results[i] !== "VERIFIED"; i--) consecutive += 1;

  const detections = input.audit
    .filter(
      (e) =>
        e.action === "CASE_CREATED" ||
        e.action === "DETECTION_RECORDED" ||
        e.action === "RECURRENCE_DETECTED",
    )
    .sort((a, b) => a.sequence - b.sequence);
  const lastDetection = detections.at(-1);
  const detectionConfidence =
    typeof lastDetection?.details?.confidence === "number" ? lastDetection.details.confidence : 0;
  const detectionReasons = Array.isArray(lastDetection?.details?.reasonCodes)
    ? (lastDetection?.details?.reasonCodes as readonly string[])
    : [];

  const dataSufficiency = latest?.assessment?.dataCompleteness ?? detectionConfidence;
  const telemetryConfidence = latest?.assessment?.telemetryConfidence ?? detectionConfidence;
  const unresolved = c.state !== "VERIFIED_IMPROVED" && c.state !== "CLOSED";
  const integrityIssue =
    latest?.assessment?.reasonCodes?.some((r) => r.startsWith("DEVICE_INTEGRITY:")) ?? false;
  const escalated = input.audit.some(
    (e) => e.action === "RISK_ESCALATED" && e.targetId === c.activeRiskEventId,
  );
  const lowEvidence =
    latest !== undefined &&
    (latestResult === "INCONCLUSIVE" ||
      dataSufficiency < input.policy.dataSufficiency.minimumForRemoteConfidence);

  const facts: InterventionFacts = {
    caseSeverity: c.severity,
    caseState: c.state,
    caseUnresolved: unresolved,
    latestVerificationResult: latestResult,
    notImprovingCount: results.filter((r) => r === "NOT_IMPROVING").length,
    partiallyVerifiedCount: results.filter((r) => r === "PARTIALLY_VERIFIED").length,
    inconclusiveCount: results.filter((r) => r === "INCONCLUSIVE").length,
    consecutiveUnsuccessfulVerifications: consecutive,
    recurrenceCount: c.recurrenceCount,
    escalated,
    dataSufficiency,
    telemetryConfidence,
    integrityIssue,
    corroboratingSignals: detectionReasons.filter((r) => CORROBORATING.has(r)).length,
    insufficientRemoteEvidence: unresolved && lowEvidence,
  };
  const evidence = [
    ...completed.map((a) => a.verificationId),
    ...detections.slice(-1).map((e) => e.auditId),
    ...input.audit.filter((e) => e.action === "RECURRENCE_DETECTED").map((e) => e.auditId),
    ...input.audit
      .filter((e) => e.action === "RISK_ESCALATED" && e.targetId === c.activeRiskEventId)
      .map((e) => e.auditId),
  ];
  return {
    facts,
    supportingEvidenceIds: [...new Set(evidence)],
    dataSufficiency,
  };
}
