import {
  VERIFICATION_RESULTS,
  domainError,
  err,
  isEarlier,
  isIsoTimestamp,
  isNonEmptyString,
  ok,
} from "@symbiosis/contracts";
import type {
  CriterionResult,
  DomainError,
  Result,
  TimeWindow,
  VerificationAssessment,
} from "@symbiosis/contracts";

/**
 * `validateVerificationAssessment` checks the VerificationAssessment contract structurally.
 * Policy execution lives in `engine.ts`; the validator remains the last line of defense.
 */

function isUnitInterval(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function checkWindow(name: string, window: TimeWindow, issues: string[]): void {
  if (!isIsoTimestamp(window?.start) || !isIsoTimestamp(window?.end)) {
    issues.push(`${name} must have ISO start and end`);
  } else if (!isEarlier(window.start, window.end)) {
    issues.push(`${name} start must be before end`);
  }
}

function checkCriteria(name: string, criteria: readonly CriterionResult[], issues: string[]): void {
  if (!Array.isArray(criteria)) {
    issues.push(`${name} must be an array`);
    return;
  }
  for (const c of criteria) {
    if (!isNonEmptyString(c?.criterionId) || typeof c.passed !== "boolean") {
      issues.push(`${name} entries need a criterionId and boolean passed`);
      return;
    }
    // S5: an explicit outcome and the boolean must agree, so `passed` can never be forged.
    if (c.outcome !== undefined && c.passed !== (c.outcome === "PASS")) {
      issues.push(`${name} entry ${c.criterionId} has passed=${c.passed} but outcome ${c.outcome}`);
      return;
    }
  }
}

/**
 * Structural/consistency validation of an assessment. It does not evaluate telemetry.
 * A VERIFIED result is rejected unless it is self-consistent: at least one required
 * criterion, every required criterion passed, and at least one evidence ID (spec 8.1).
 */
export function validateVerificationAssessment(
  assessment: VerificationAssessment,
): Result<VerificationAssessment, DomainError> {
  if (assessment === null || typeof assessment !== "object") {
    return err(
      domainError("INVALID_INPUT", "VERIFICATION", "A verification assessment is required", {
        issues: ["assessment is missing"],
      }),
    );
  }
  const issues: string[] = [];
  for (const key of [
    "verificationId",
    "caseId",
    "eventId",
    "policyId",
    "policyVersion",
    "deviceHealthStatus",
    "authIntegrityStatus",
  ] as const) {
    if (!isNonEmptyString(assessment[key])) issues.push(`${key} is required`);
  }
  checkWindow("baselineWindow", assessment.baselineWindow, issues);
  checkWindow("postActionWindow", assessment.postActionWindow, issues);
  checkCriteria("requiredCriteria", assessment.requiredCriteria, issues);
  checkCriteria("supportingCriteria", assessment.supportingCriteria, issues);
  if (!isUnitInterval(assessment.dataCompleteness)) issues.push("dataCompleteness must be 0..1");
  if (!isUnitInterval(assessment.telemetryConfidence)) {
    issues.push("telemetryConfidence must be 0..1");
  }
  if (!isUnitInterval(assessment.confidence)) issues.push("confidence must be 0..1");
  if (!VERIFICATION_RESULTS.includes(assessment.result)) issues.push("result is not allowed");
  if (!Array.isArray(assessment.evidenceIds) || !assessment.evidenceIds.every(isNonEmptyString)) {
    issues.push("evidenceIds must be an array of non-empty IDs");
  }
  if (!isIsoTimestamp(assessment.evaluatedAt)) issues.push("evaluatedAt must be ISO-8601");

  if (issues.length === 0 && assessment.result === "VERIFIED") {
    if (assessment.requiredCriteria.length === 0) {
      issues.push("VERIFIED requires at least one required criterion");
    }
    if (!assessment.requiredCriteria.every((c) => c.passed)) {
      issues.push("VERIFIED requires every required criterion to pass");
    }
    if (assessment.evidenceIds.length === 0) issues.push("VERIFIED requires evidence IDs");
  }

  return issues.length === 0
    ? ok(assessment)
    : err(
        domainError("INVALID_INPUT", "VERIFICATION", "Invalid verification assessment", { issues }),
      );
}
