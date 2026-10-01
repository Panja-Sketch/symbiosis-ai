import type { VerificationAssessment } from "@symbiosis/contracts";

/** Synthetic test fixture (not telemetry-derived). Used by tests across domain packages. */
export function sampleAssessment(
  overrides: Partial<VerificationAssessment> = {},
): VerificationAssessment {
  return {
    verificationId: "VER-1",
    caseId: "CASE-1",
    eventId: "EVT-1",
    policyId: "POL-TEST",
    policyVersion: "1",
    baselineWindow: { start: "2026-01-01T00:00:00Z", end: "2026-01-01T01:00:00Z" },
    postActionWindow: { start: "2026-01-01T02:00:00Z", end: "2026-01-01T03:00:00Z" },
    requiredCriteria: [{ criterionId: "C-1", passed: true }],
    supportingCriteria: [],
    dataCompleteness: 1,
    telemetryConfidence: 0.9,
    deviceHealthStatus: "HEALTHY",
    authIntegrityStatus: "VERIFIED",
    result: "VERIFIED",
    confidence: 0.9,
    evidenceIds: ["EV-1"],
    evaluatedAt: "2026-01-01T03:00:01Z",
    ...overrides,
  };
}
