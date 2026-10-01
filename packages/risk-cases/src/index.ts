import {
  CASE_SEVERITIES,
  CASE_STATES,
  SHARING_STATES,
  domainError,
  err,
  isEarlier,
  isIsoTimestamp,
  isNonEmptyString,
  ok,
} from "@symbiosis/contracts";
import type {
  CaseState,
  DomainError,
  IsoTimestamp,
  Result,
  RiskImprovementCase,
  Transitioned,
  VerificationAssessment,
} from "@symbiosis/contracts";
import { validateVerificationAssessment } from "@symbiosis/verification";

export const PACKAGE_NAME = "@symbiosis/risk-cases" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/**
 * Allowed case state transitions (spec section 4). A verified state is reachable only from
 * VERIFYING, and only via RECORD_VERIFICATION with a valid assessment. CLOSED is
 * administrative and never implies verification.
 */
export const CASE_TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  OPEN: ["ACTION_REQUIRED", "CLOSED"],
  ACTION_REQUIRED: ["ACTION_REPORTED", "CLOSED"],
  ACTION_REPORTED: ["VERIFYING", "CLOSED"],
  VERIFYING: ["VERIFIED_IMPROVED", "PARTIALLY_VERIFIED", "NOT_IMPROVING", "INCONCLUSIVE"],
  VERIFIED_IMPROVED: ["CLOSED", "REOPENED"],
  PARTIALLY_VERIFIED: ["ACTION_REQUIRED", "CLOSED"],
  NOT_IMPROVING: ["ACTION_REQUIRED", "CLOSED"],
  INCONCLUSIVE: ["VERIFYING", "ACTION_REQUIRED", "CLOSED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["ACTION_REQUIRED", "CLOSED"],
};

/** States from which a material recurrence may reopen the case. */
const RECURRENCE_ELIGIBLE: readonly CaseState[] = ["VERIFIED_IMPROVED", "CLOSED"];

/** States that can only be held after a verification outcome was recorded. */
const VERIFICATION_BACKED: readonly CaseState[] = [
  "VERIFIED_IMPROVED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
];

export function canTransitionCase(from: CaseState, to: CaseState): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export type CreateCaseInput = Omit<
  RiskImprovementCase,
  | "state"
  | "recurrenceCount"
  | "sharingState"
  | "updatedAt"
  | "latestVerificationId"
  | "latestEvidencePackageId"
>;

function originReference(origin: RiskImprovementCase["origin"]): unknown {
  switch (origin?.type) {
    case "RECOMMENDATION":
      return origin.recommendationId;
    case "DETECTED_HAZARD":
      return origin.detectionId;
    case "MANUAL_RISK_REVIEW":
      return origin.reviewId;
    default:
      return undefined;
  }
}

/** Collects invariant violations for any case object (also usable on rehydrated data). */
export function checkCaseInvariants(c: RiskImprovementCase): string[] {
  const issues: string[] = [];
  for (const key of ["caseId", "organizationId", "facilityId", "hazardType", "title"] as const) {
    if (!isNonEmptyString(c[key])) issues.push(`${key} is required`);
  }
  if (!Array.isArray(c.assetIds) || c.assetIds.length === 0) {
    issues.push("assetIds must contain at least one asset");
  } else if (!c.assetIds.every(isNonEmptyString)) {
    issues.push("assetIds must be non-empty strings");
  }
  if (!isNonEmptyString(originReference(c.origin))) issues.push("origin is invalid");
  if (!CASE_SEVERITIES.includes(c.severity)) issues.push("severity is not allowed");
  if (!CASE_STATES.includes(c.state)) issues.push("state is not allowed");
  if (!SHARING_STATES.includes(c.sharingState)) issues.push("sharingState is not allowed");
  if (!Number.isInteger(c.recurrenceCount) || c.recurrenceCount < 0) {
    issues.push("recurrenceCount must be a non-negative integer");
  }
  if (!isIsoTimestamp(c.createdAt) || !isIsoTimestamp(c.updatedAt)) {
    issues.push("createdAt and updatedAt must be ISO-8601");
  } else if (isEarlier(c.updatedAt, c.createdAt)) {
    issues.push("updatedAt must not precede createdAt");
  }
  if (c.targetDate !== undefined && !isIsoTimestamp(c.targetDate)) {
    issues.push("targetDate must be ISO-8601");
  }
  if (VERIFICATION_BACKED.includes(c.state) && !isNonEmptyString(c.latestVerificationId)) {
    issues.push(`${c.state} requires latestVerificationId`);
  }
  if (c.state === "REOPENED" && c.recurrenceCount < 1) {
    issues.push("REOPENED requires recurrenceCount >= 1");
  }
  return issues;
}

export function validateRiskImprovementCase(
  c: RiskImprovementCase,
): Result<RiskImprovementCase, DomainError> {
  const issues = checkCaseInvariants(c);
  return issues.length === 0
    ? ok(c)
    : err(domainError("INVALID_INPUT", "CASE", "Invalid risk improvement case", { issues }));
}

/** New cases always start OPEN, unshared, with zero recurrences. */
export function createRiskImprovementCase(
  input: CreateCaseInput,
): Result<RiskImprovementCase, DomainError> {
  const candidate: RiskImprovementCase = {
    ...input,
    assetIds: [...input.assetIds],
    state: "OPEN",
    recurrenceCount: 0,
    sharingState: "NOT_SHARED",
    updatedAt: input.createdAt,
  };
  const valid = validateRiskImprovementCase(candidate);
  return valid.ok ? ok(Object.freeze(candidate)) : valid;
}

export type CaseCommand =
  | {
      readonly type: "REQUIRE_ACTION";
      readonly at: IsoTimestamp;
      readonly riskEventId?: string;
      readonly ownerId?: string;
      readonly targetDate?: string;
    }
  | {
      readonly type: "REPORT_ACTION";
      readonly at: IsoTimestamp;
      readonly actionId: string;
      readonly actorId?: string;
    }
  | { readonly type: "START_VERIFICATION"; readonly at: IsoTimestamp }
  | {
      readonly type: "RECORD_VERIFICATION";
      readonly at: IsoTimestamp;
      readonly assessment: VerificationAssessment;
    }
  | {
      readonly type: "RECORD_RECURRENCE";
      readonly at: IsoTimestamp;
      readonly newRiskEventId: string;
    }
  | {
      readonly type: "CLOSE";
      readonly at: IsoTimestamp;
      readonly actorId: string;
      readonly reason: string;
    };

const VERIFICATION_TARGET: Readonly<Record<VerificationAssessment["result"], CaseState>> = {
  VERIFIED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

function targetState(command: CaseCommand): CaseState {
  switch (command.type) {
    case "REQUIRE_ACTION":
      return "ACTION_REQUIRED";
    case "REPORT_ACTION":
      return "ACTION_REPORTED";
    case "START_VERIFICATION":
      return "VERIFYING";
    case "RECORD_VERIFICATION":
      return VERIFICATION_TARGET[command.assessment.result];
    case "RECORD_RECURRENCE":
      return "REOPENED";
    case "CLOSE":
      return "CLOSED";
  }
}

function invalid(message: string): DomainError {
  return domainError("INVALID_INPUT", "CASE", message);
}

/**
 * Pure, deterministic state machine for the case aggregate. Acknowledgement is deliberately
 * not a command: it does not change physical-risk state. Returns a new case plus a
 * TransitionRecord; the input is never mutated.
 */
export function applyCaseCommand(
  c: RiskImprovementCase,
  command: CaseCommand,
): Result<Transitioned<RiskImprovementCase, CaseState>, DomainError> {
  if (!isIsoTimestamp(command.at)) return err(invalid("command.at must be ISO-8601"));
  if (isEarlier(command.at, c.updatedAt)) {
    return err(
      domainError("TIMESTAMP_REGRESSION", "CASE", "command.at precedes the case's last update"),
    );
  }
  const from = c.state;
  let patch: Partial<RiskImprovementCase> = {};

  switch (command.type) {
    case "RECORD_VERIFICATION": {
      const valid = validateVerificationAssessment(command.assessment);
      if (!valid.ok) {
        return err(
          domainError(
            "MISSING_VERIFICATION_REFERENCE",
            "CASE",
            "A valid verification assessment is required to record a verification outcome",
            valid.error.issues ? { issues: valid.error.issues } : {},
          ),
        );
      }
      break;
    }
    case "RECORD_RECURRENCE":
      if (!RECURRENCE_ELIGIBLE.includes(from)) {
        return err(
          domainError(
            "INVALID_RECURRENCE",
            "CASE",
            `Recurrence can only be recorded for a verified or closed case, not ${from}`,
            { from },
          ),
        );
      }
      if (
        !isNonEmptyString(command.newRiskEventId) ||
        command.newRiskEventId === c.activeRiskEventId
      ) {
        return err(
          domainError(
            "INVALID_RECURRENCE",
            "CASE",
            "Recurrence requires a new risk event distinct from the active one",
          ),
        );
      }
      break;
    default:
      break;
  }

  const to = targetState(command);
  if (!canTransitionCase(from, to)) {
    return err(
      domainError(
        "ILLEGAL_LIFECYCLE_TRANSITION",
        "CASE",
        `Illegal case transition ${from} -> ${to}`,
        { from, to },
      ),
    );
  }

  switch (command.type) {
    case "REQUIRE_ACTION":
      if (command.riskEventId !== undefined && !isNonEmptyString(command.riskEventId)) {
        return err(invalid("riskEventId must be non-empty when provided"));
      }
      if (command.ownerId !== undefined && !isNonEmptyString(command.ownerId)) {
        return err(invalid("ownerId must be non-empty when provided"));
      }
      if (command.targetDate !== undefined && !isIsoTimestamp(command.targetDate)) {
        return err(invalid("targetDate must be ISO-8601"));
      }
      patch = {
        ...(command.riskEventId !== undefined && { activeRiskEventId: command.riskEventId }),
        ...(command.ownerId !== undefined && { assignedOwnerId: command.ownerId }),
        ...(command.targetDate !== undefined && { targetDate: command.targetDate }),
      };
      break;
    case "REPORT_ACTION":
      if (!isNonEmptyString(command.actionId)) return err(invalid("actionId is required"));
      if (c.activeRiskEventId === undefined) {
        return err(
          domainError(
            "MISSING_ACTIVE_RISK_EVENT",
            "CASE",
            "An action can only be reported against an active risk event",
          ),
        );
      }
      break;
    case "START_VERIFICATION":
      if (c.activeRiskEventId === undefined) {
        return err(
          domainError(
            "MISSING_ACTIVE_RISK_EVENT",
            "CASE",
            "Verification requires an active risk event",
          ),
        );
      }
      break;
    case "RECORD_VERIFICATION":
      if (
        command.assessment.caseId !== c.caseId ||
        command.assessment.eventId !== c.activeRiskEventId
      ) {
        return err(
          domainError(
            "VERIFICATION_MISMATCH",
            "CASE",
            "Assessment does not belong to this case's active risk event",
          ),
        );
      }
      patch = { latestVerificationId: command.assessment.verificationId };
      break;
    case "RECORD_RECURRENCE":
      patch = {
        activeRiskEventId: command.newRiskEventId,
        recurrenceCount: c.recurrenceCount + 1,
      };
      break;
    case "CLOSE":
      if (!isNonEmptyString(command.actorId) || !isNonEmptyString(command.reason)) {
        return err(invalid("Closure requires an actor and a reason"));
      }
      break;
  }

  const next: RiskImprovementCase = { ...c, ...patch, state: to, updatedAt: command.at };
  const actorId = "actorId" in command ? command.actorId : undefined;
  return ok({
    value: Object.freeze(next),
    record: {
      entity: "CASE",
      entityId: c.caseId,
      from,
      to,
      command: command.type,
      at: command.at,
      ...(actorId !== undefined && { actorId }),
    },
  });
}
