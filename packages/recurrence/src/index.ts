import { domainError, err, isEarlier, ok } from "@symbiosis/contracts";
import type {
  CaseState,
  DomainError,
  Result,
  RiskDetection,
  RiskEvent,
  RiskImprovementCase,
  TransitionRecord,
  VerificationAttempt,
} from "@symbiosis/contracts";
import { applyCaseCommand } from "@symbiosis/risk-cases";
import {
  caseMatchesDetection,
  createRiskEvent,
  reopenOnRecurrence,
} from "@symbiosis/risk-lifecycle";

export const PACKAGE_NAME = "@symbiosis/recurrence" as const;
export const SCAFFOLD_PHASE = "S5" as const;

/**
 * Recurrence matching (spec 8.3). Prototype rule (D-043):
 *  - inside the recurrence-watch window of the case's VERIFIED verification -> reopen that case;
 *  - outside the window (or with no usable verified record) -> the detection is an ordinary new
 *    episode and the caller opens a new case.
 * The window ends at `verification.recurrenceWatchEndsAt`, which is the end of the verified
 * post-action window plus the policy's `recurrenceWatch.seconds` (fixed when the verification
 * completed, so a later policy change cannot move it).
 *
 * Only a RiskDetection (the persistent compound rule of S3) can reach this code, so a single
 * WATCH signal never reopens a case; the guard below keeps that true for hand-built input too.
 */
export type VerifiedCaseCandidate = {
  readonly caseRecord: RiskImprovementCase;
  /** The verification the case points at via `latestVerificationId`, if it could be loaded. */
  readonly verification: VerificationAttempt | undefined;
};

export type RecurrenceDecision =
  | {
      readonly kind: "REOPEN";
      readonly caseRecord: RiskImprovementCase;
      readonly verification: VerificationAttempt;
      readonly watchEndsAt: string;
    }
  | {
      readonly kind: "NONE";
      readonly reason:
        "DETECTION_NOT_QUALIFIED" | "NO_VERIFIED_CASE_FOR_EPISODE" | "OUTSIDE_RECURRENCE_WINDOW";
    };

export function isQualifiedDetection(d: RiskDetection): boolean {
  return (
    d.persistence.required >= 1 &&
    d.persistence.qualifyingEvaluations >= d.persistence.required &&
    d.reasonCodes.length > 0
  );
}

export function decideRecurrence(input: {
  readonly detection: RiskDetection;
  /** VERIFIED_IMPROVED cases of the episode identity, most recently updated first. */
  readonly candidates: readonly VerifiedCaseCandidate[];
}): RecurrenceDecision {
  const { detection } = input;
  if (!isQualifiedDetection(detection)) return { kind: "NONE", reason: "DETECTION_NOT_QUALIFIED" };

  let sawMatch = false;
  for (const { caseRecord, verification } of input.candidates) {
    if (caseRecord.state !== "VERIFIED_IMPROVED" || !caseMatchesDetection(caseRecord, detection)) {
      continue;
    }
    sawMatch = true;
    if (
      verification === undefined ||
      verification.status !== "COMPLETED" ||
      verification.assessment?.result !== "VERIFIED" ||
      verification.verificationId !== caseRecord.latestVerificationId ||
      verification.recurrenceWatchEndsAt === undefined
    ) {
      continue;
    }
    // inclusive end: a detection exactly at the end of the watch window still counts
    if (isEarlier(verification.recurrenceWatchEndsAt, detection.detectedAt)) continue;
    return {
      kind: "REOPEN",
      caseRecord,
      verification,
      watchEndsAt: verification.recurrenceWatchEndsAt,
    };
  }
  return {
    kind: "NONE",
    reason: sawMatch ? "OUTSIDE_RECURRENCE_WINDOW" : "NO_VERIFIED_CASE_FOR_EPISODE",
  };
}

export type ReopenResult = {
  readonly case: RiskImprovementCase;
  readonly newEvent: RiskEvent;
  readonly previousRiskEventId: string;
  readonly caseRecord: TransitionRecord<CaseState>;
};

/**
 * Reopens the verified case for a recurrence: a NEW risk event (DETECTED), the same case moved
 * to REOPENED with `recurrenceCount + 1`, severity raised if the new detection is worse. The
 * previous event and every prior verification stay exactly as they were (nothing here touches
 * them). Fails closed with a domain error if any step is illegal.
 */
export function reopenCaseForRecurrence(input: {
  readonly caseRecord: RiskImprovementCase;
  readonly detection: RiskDetection;
  readonly newEventId: string;
}): Result<ReopenResult, DomainError> {
  const { caseRecord: c, detection: d } = input;
  if (c.activeRiskEventId === undefined) {
    return err(
      domainError("MISSING_ACTIVE_RISK_EVENT", "CASE", "A verified case has no risk event"),
    );
  }
  const assetIds = [d.primaryAssetId, ...d.contextAssetIds.filter((a) => a !== d.primaryAssetId)];
  const fresh = createRiskEvent({
    eventId: input.newEventId,
    caseId: c.caseId,
    organizationId: c.organizationId,
    facilityId: c.facilityId,
    assetIds,
    detectedAt: d.detectedAt,
  });
  if (!fresh.ok) return fresh;
  const reopened = reopenOnRecurrence({ case: c, newEvent: fresh.value, at: d.detectedAt });
  if (!reopened.ok) return reopened;
  // The new episode may be worse than the verified one: severity may only rise.
  const raised = applyCaseCommand(reopened.value.case, {
    type: "RECORD_DETECTION",
    at: d.detectedAt,
    detectionId: d.detectionId,
    severity: d.severity,
  });
  if (!raised.ok) return raised;
  return ok({
    case: raised.value.value,
    newEvent: fresh.value,
    previousRiskEventId: c.activeRiskEventId,
    caseRecord: reopened.value.caseRecord,
  });
}
