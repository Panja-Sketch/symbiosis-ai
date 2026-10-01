import {
  RECOMMENDATION_SOURCES,
  domainError,
  err,
  isIsoTimestamp,
  isNonEmptyString,
  ok,
} from "@symbiosis/contracts";
import type {
  DomainError,
  IsoTimestamp,
  RecommendationStatus,
  Result,
  RiskRecommendation,
  Transitioned,
  VerificationAssessment,
} from "@symbiosis/contracts";
import { validateVerificationAssessment } from "@symbiosis/verification";

export const PACKAGE_NAME = "@symbiosis/recommendations" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Allowed status transitions. CLOSED is administrative and is never VERIFIED. */
export const RECOMMENDATION_TRANSITIONS: Readonly<
  Record<RecommendationStatus, readonly RecommendationStatus[]>
> = {
  OPEN: ["ACTION_REPORTED", "CLOSED"],
  ACTION_REPORTED: ["VERIFYING", "CLOSED"],
  VERIFYING: ["VERIFIED", "PARTIAL", "UNVERIFIED"],
  VERIFIED: ["CLOSED", "REOPENED"],
  PARTIAL: ["ACTION_REPORTED", "VERIFYING", "CLOSED"],
  UNVERIFIED: ["ACTION_REPORTED", "VERIFYING", "CLOSED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["ACTION_REPORTED", "CLOSED"],
};

export type RecommendationInput = Omit<RiskRecommendation, "status">;

export function createRiskRecommendation(
  input: RecommendationInput,
): Result<RiskRecommendation, DomainError> {
  const issues: string[] = [];
  for (const key of [
    "recommendationId",
    "organizationId",
    "facilityId",
    "hazardType",
    "description",
  ] as const) {
    if (!isNonEmptyString(input[key])) issues.push(`${key} is required`);
  }
  if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) {
    issues.push("assetIds must contain at least one asset");
  } else if (!input.assetIds.every(isNonEmptyString)) {
    issues.push("assetIds must be non-empty strings");
  }
  if (!RECOMMENDATION_SOURCES.includes(input.source)) issues.push("source is not allowed");
  if (!Array.isArray(input.approvedActionIds) || !input.approvedActionIds.every(isNonEmptyString)) {
    issues.push("approvedActionIds must be an array of non-empty IDs");
  }
  if (input.targetDate !== undefined && !isIsoTimestamp(input.targetDate)) {
    issues.push("targetDate must be ISO-8601");
  }
  if (issues.length > 0) {
    return err(
      domainError("INVALID_INPUT", "RECOMMENDATION", "Invalid recommendation", { issues }),
    );
  }
  return ok(Object.freeze({ ...input, assetIds: [...input.assetIds], status: "OPEN" as const }));
}

export type RecommendationCommand =
  | { readonly type: "REPORT_ACTION"; readonly at: IsoTimestamp; readonly actorId?: string }
  | { readonly type: "START_VERIFICATION"; readonly at: IsoTimestamp }
  | {
      readonly type: "RECORD_VERIFICATION";
      readonly at: IsoTimestamp;
      readonly assessment: VerificationAssessment;
    }
  | { readonly type: "CLOSE"; readonly at: IsoTimestamp; readonly actorId: string }
  | { readonly type: "REOPEN"; readonly at: IsoTimestamp; readonly actorId?: string };

export function canTransitionRecommendation(
  from: RecommendationStatus,
  to: RecommendationStatus,
): boolean {
  return RECOMMENDATION_TRANSITIONS[from].includes(to);
}

/** `VERIFIED` is reachable only through a valid VERIFIED assessment. */
export function isRecommendationVerified(recommendation: RiskRecommendation): boolean {
  return recommendation.status === "VERIFIED";
}

function targetFor(command: RecommendationCommand): Result<RecommendationStatus, DomainError> {
  switch (command.type) {
    case "REPORT_ACTION":
      return ok("ACTION_REPORTED");
    case "START_VERIFICATION":
      return ok("VERIFYING");
    case "CLOSE":
      return ok("CLOSED");
    case "REOPEN":
      return ok("REOPENED");
    case "RECORD_VERIFICATION": {
      const valid = validateVerificationAssessment(command.assessment);
      if (!valid.ok) {
        return err(
          domainError(
            "MISSING_VERIFICATION_REFERENCE",
            "RECOMMENDATION",
            "A valid verification assessment is required to record a verification outcome",
            valid.error.issues ? { issues: valid.error.issues } : {},
          ),
        );
      }
      switch (command.assessment.result) {
        case "VERIFIED":
          return ok("VERIFIED");
        case "PARTIALLY_VERIFIED":
          return ok("PARTIAL");
        case "NOT_IMPROVING":
        case "INCONCLUSIVE":
          return ok("UNVERIFIED");
      }
    }
  }
}

export function applyRecommendationCommand(
  recommendation: RiskRecommendation,
  command: RecommendationCommand,
): Result<Transitioned<RiskRecommendation, RecommendationStatus>, DomainError> {
  if (!isIsoTimestamp(command.at)) {
    return err(domainError("INVALID_INPUT", "RECOMMENDATION", "command.at must be ISO-8601"));
  }
  const from = recommendation.status;
  if (command.type === "RECORD_VERIFICATION" && from !== "VERIFYING") {
    return err(
      domainError(
        "ILLEGAL_RECOMMENDATION_TRANSITION",
        "RECOMMENDATION",
        `Cannot record verification while ${from}`,
        { from },
      ),
    );
  }
  const target = targetFor(command);
  if (!target.ok) return target;
  const to = target.value;
  if (!canTransitionRecommendation(from, to)) {
    return err(
      domainError(
        "ILLEGAL_RECOMMENDATION_TRANSITION",
        "RECOMMENDATION",
        `Illegal recommendation transition ${from} -> ${to}`,
        { from, to },
      ),
    );
  }
  return ok({
    value: Object.freeze({ ...recommendation, status: to }),
    record: {
      entity: "RECOMMENDATION",
      entityId: recommendation.recommendationId,
      from,
      to,
      command: command.type,
      at: command.at,
      ...("actorId" in command && command.actorId !== undefined && { actorId: command.actorId }),
    },
  });
}
