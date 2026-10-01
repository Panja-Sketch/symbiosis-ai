import { buildFacilityContext, buildInsurerContext } from "./facts";
import type { FacilityCaseInput, InsurerCaseInput } from "./facts";

/** Hand-written case inputs for unit tests (the integration tests use real API output instead). */

export const RESULTS = ["VERIFIED", "PARTIALLY_VERIFIED", "NOT_IMPROVING", "INCONCLUSIVE"] as const;
const STATE_FOR: Record<string, string> = {
  VERIFIED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

export function facilityInput(
  result: string | undefined = "VERIFIED",
  extra: Partial<FacilityCaseInput> = {},
): FacilityCaseInput {
  const base: FacilityCaseInput = {
    caseId: "CASE-1",
    title: "t",
    hazardType: "COOLING_ELECTRICAL_DETERIORATION",
    severity: "MODERATE",
    facilityId: "FAC-1",
    assetIds: ["AST-FAN-A"],
    state: result === undefined ? "ACTION_REPORTED" : (STATE_FOR[result] ?? "OPEN"),
    riskEventId: "RE-1",
    riskEventState: "VERIFIED",
    reasonCodes: ["VIBRATION_Z_AT_OR_ABOVE_THRESHOLD", "PERSISTED_3_OF_3"],
    detectionCount: 1,
    latestDetectionAt: "2026-10-01T00:02:15.000Z",
    accountability: {
      acknowledgement: { acknowledged: true, at: "2026-10-01T00:02:20.000Z" },
      escalation: { escalated: false },
    },
    whatToDo: {
      approvedActions: [
        {
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
          title: "Inspect the primary cooling assembly",
        },
        {
          actionLibraryId: "ACT-COOLING-START-BACKUP",
          title: "Start approved backup cooling capacity",
        },
      ],
    },
    whatWasDone: {
      actions: [
        {
          actionId: "ACT-9",
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
          title: "Inspect the primary cooling assembly",
          status: "REPORTED_COMPLETE",
          reportedAt: "2026-10-01T00:02:20.000Z",
          notes: "Looked at the fan.",
        },
      ],
    },
    didItWork: {
      status:
        result === undefined
          ? "VERIFICATION_PENDING"
          : result === "VERIFIED"
            ? "VERIFIED_IMPROVED"
            : result,
      label: "x",
    },
    ...(result !== undefined && {
      verification: {
        verificationId: "VER-1",
        status: "COMPLETED",
        policyId: "VPOL-COOLING-ELECTRICAL",
        policyVersion: "1",
        evaluatedAt: "2026-10-01T00:04:25.000Z",
        result,
        confidence: 0.9,
        dataCompleteness: 0.95,
        telemetryConfidence: 0.92,
        deviceHealthStatus: "HEALTHY",
        authIntegrityStatus: "VERIFIED",
        reasonCodes: [
          result === "VERIFIED" ? "ALL_REQUIRED_CRITERIA_PASSED" : "STILL_MATERIALLY_ABNORMAL",
        ],
        criteria: [
          {
            criterionId: "VIBRATION",
            role: "REQUIRED",
            outcome: result === "VERIFIED" ? "PASS" : "FAIL",
            before: { sampleCount: 28, mean: 0.1982 },
            observed: { sampleCount: 13, mean: 0.1805 },
            reasonCodes: [],
          },
        ],
      },
    }),
    stayingFixed: {
      watch: "WATCHING",
      watchEndsAt: "2026-10-01T01:04:20.000Z",
      recurrenceCount: 0,
    },
    intervention: {
      interventionId: "INT-1",
      level: "REMOTE_MONITORING",
      status: "ACTIVE",
      policyId: "IPOL-X",
      policyVersion: "1",
      reasonCodes: ["NO_ESCALATION_CONDITION_MET"],
      dataSufficiency: 1,
    },
    evidence: { latestEvidencePackageId: "EVP-1" },
    sharing: { state: "SHAREABLE" },
  };
  return { ...base, ...extra };
}

export const facilityContext = (
  result: string | undefined = "VERIFIED",
  extra: Partial<FacilityCaseInput> = {},
) =>
  buildFacilityContext(facilityInput(result, extra), {
    packageId: "EVP-1",
    createdAt: "2026-10-01T00:04:25.000Z",
    integrity: "PASSED",
    synthetic: true,
    sourceLabel: "SYNTHETIC DATA: simulator",
    artifactCount: 82,
  });

export function insurerInput(
  scopes: readonly string[] = ["RECOMMENDATION", "VERIFICATION_RESULT"],
): InsurerCaseInput {
  const has = (s: string) => scopes.includes(s);
  return {
    caseId: "CASE-1",
    siteId: "FAC-1",
    consent: { grantedScopes: scopes },
    sharingState: "SHARED",
    ...(has("RECOMMENDATION") && {
      recommendation: {
        hazardType: "COOLING_ELECTRICAL_DETERIORATION",
        severity: "MODERATE",
        caseState: "VERIFIED_IMPROVED",
      },
    }),
    ...(has("VERIFICATION_RESULT") && {
      verification: {
        result: "VERIFIED",
        policyId: "VPOL-COOLING-ELECTRICAL",
        policyVersion: "1",
        evaluatedAt: "2026-10-01T00:04:25.000Z",
        reasonCodes: ["ALL_REQUIRED_CRITERIA_PASSED"],
        criteria: [{ criterionId: "VIBRATION", role: "REQUIRED", outcome: "PASS" }],
      },
    }),
  };
}

export const insurerContext = (scopes?: readonly string[]) =>
  buildInsurerContext(insurerInput(scopes));
