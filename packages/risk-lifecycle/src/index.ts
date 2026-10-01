import {
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
  RiskEvent,
  RiskEventState,
  RiskDetection,
  RiskImprovementCase,
  Transitioned,
  TransitionRecord,
  VerificationAssessment,
} from "@symbiosis/contracts";
import { applyCaseCommand, createRiskImprovementCase } from "@symbiosis/risk-cases";
import { validateVerificationAssessment } from "@symbiosis/verification";

export const PACKAGE_NAME = "@symbiosis/risk-lifecycle" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/**
 * Risk event lifecycle (spec section 6). Terminal states have no outgoing transitions: a
 * recurrence after VERIFIED creates a NEW event (see reopenOnRecurrence), it does not
 * revive the old one. Outcome states may re-enter ACTION_REPORTED for another action cycle.
 */
export const RISK_EVENT_TRANSITIONS: Readonly<Record<RiskEventState, readonly RiskEventState[]>> = {
  DETECTED: ["ALERTED", "SELF_RESOLVED", "DISMISSED_FALSE_ALARM"],
  ALERTED: ["ACKNOWLEDGED", "ESCALATED", "SELF_RESOLVED", "DISMISSED_FALSE_ALARM"],
  ESCALATED: ["ACKNOWLEDGED", "SELF_RESOLVED", "DISMISSED_FALSE_ALARM"],
  ACKNOWLEDGED: ["ACTION_REPORTED", "SELF_RESOLVED", "DISMISSED_FALSE_ALARM"],
  ACTION_REPORTED: ["VERIFYING"],
  VERIFYING: ["VERIFIED", "PARTIALLY_VERIFIED", "NOT_IMPROVING", "INCONCLUSIVE"],
  VERIFIED: [],
  PARTIALLY_VERIFIED: ["ACTION_REPORTED"],
  NOT_IMPROVING: ["ACTION_REPORTED"],
  INCONCLUSIVE: ["VERIFYING", "ACTION_REPORTED"],
  SELF_RESOLVED: [],
  DISMISSED_FALSE_ALARM: [],
};

export function canTransitionRiskEvent(from: RiskEventState, to: RiskEventState): boolean {
  return RISK_EVENT_TRANSITIONS[from].includes(to);
}

/**
 * Only an independently VERIFIED event earns mitigation credit. SELF_RESOLVED (readings
 * normalized with no reported action), dismissals, and unverified outcomes earn none.
 */
export function grantsMitigationCredit(state: RiskEventState): boolean {
  return state === "VERIFIED";
}

export type CreateRiskEventInput = {
  readonly eventId: string;
  readonly caseId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly detectedAt: IsoTimestamp;
};

export function createRiskEvent(input: CreateRiskEventInput): Result<RiskEvent, DomainError> {
  const issues: string[] = [];
  for (const key of ["eventId", "caseId", "organizationId", "facilityId"] as const) {
    if (!isNonEmptyString(input[key])) issues.push(`${key} is required`);
  }
  if (!Array.isArray(input.assetIds) || input.assetIds.length === 0) {
    issues.push("assetIds must contain at least one asset");
  } else if (!input.assetIds.every(isNonEmptyString)) {
    issues.push("assetIds must be non-empty strings");
  }
  if (!isIsoTimestamp(input.detectedAt)) issues.push("detectedAt must be ISO-8601");
  if (issues.length > 0) {
    return err(domainError("INVALID_INPUT", "RISK_EVENT", "Invalid risk event", { issues }));
  }
  return ok(
    Object.freeze({
      ...input,
      assetIds: [...input.assetIds],
      state: "DETECTED" as const,
      updatedAt: input.detectedAt,
    }),
  );
}

export type RiskEventCommand =
  | { readonly type: "ALERT"; readonly at: IsoTimestamp }
  | { readonly type: "ACKNOWLEDGE"; readonly at: IsoTimestamp; readonly actorId: string }
  | { readonly type: "ESCALATE"; readonly at: IsoTimestamp }
  | {
      readonly type: "REPORT_ACTION";
      readonly at: IsoTimestamp;
      readonly actorId: string;
      readonly actionId: string;
    }
  | { readonly type: "START_VERIFICATION"; readonly at: IsoTimestamp }
  | {
      readonly type: "COMPLETE_VERIFICATION";
      readonly at: IsoTimestamp;
      readonly assessment: VerificationAssessment;
    }
  | { readonly type: "MARK_SELF_RESOLVED"; readonly at: IsoTimestamp }
  | {
      readonly type: "DISMISS_FALSE_ALARM";
      readonly at: IsoTimestamp;
      readonly actorId: string;
      readonly reason: string;
    };

const VERIFICATION_TARGET: Readonly<Record<VerificationAssessment["result"], RiskEventState>> = {
  VERIFIED: "VERIFIED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

function targetState(command: RiskEventCommand): RiskEventState {
  switch (command.type) {
    case "ALERT":
      return "ALERTED";
    case "ACKNOWLEDGE":
      return "ACKNOWLEDGED";
    case "ESCALATE":
      return "ESCALATED";
    case "REPORT_ACTION":
      return "ACTION_REPORTED";
    case "START_VERIFICATION":
      return "VERIFYING";
    case "COMPLETE_VERIFICATION":
      return VERIFICATION_TARGET[command.assessment.result];
    case "MARK_SELF_RESOLVED":
      return "SELF_RESOLVED";
    case "DISMISS_FALSE_ALARM":
      return "DISMISSED_FALSE_ALARM";
  }
}

function invalid(message: string): DomainError {
  return domainError("INVALID_INPUT", "RISK_EVENT", message);
}

/**
 * Pure, deterministic event state machine. Authorization of dismissals is the caller's
 * responsibility (authz package); here an actor and reason are mandatory so the audit
 * record is never anonymous.
 */
export function applyRiskEventCommand(
  event: RiskEvent,
  command: RiskEventCommand,
): Result<Transitioned<RiskEvent, RiskEventState>, DomainError> {
  if (!isIsoTimestamp(command.at)) return err(invalid("command.at must be ISO-8601"));
  if (isEarlier(command.at, event.updatedAt)) {
    return err(
      domainError(
        "TIMESTAMP_REGRESSION",
        "RISK_EVENT",
        "command.at precedes the event's last update",
      ),
    );
  }

  if (command.type === "COMPLETE_VERIFICATION") {
    const valid = validateVerificationAssessment(command.assessment);
    if (!valid.ok) {
      return err(
        domainError(
          "MISSING_VERIFICATION_REFERENCE",
          "RISK_EVENT",
          "A valid verification assessment is required to complete verification",
          valid.error.issues ? { issues: valid.error.issues } : {},
        ),
      );
    }
  }

  const from = event.state;
  const to = targetState(command);
  if (!canTransitionRiskEvent(from, to)) {
    return err(
      domainError(
        "ILLEGAL_LIFECYCLE_TRANSITION",
        "RISK_EVENT",
        `Illegal risk event transition ${from} -> ${to}`,
        { from, to },
      ),
    );
  }

  let patch: Partial<RiskEvent> = {};
  switch (command.type) {
    case "ACKNOWLEDGE":
      if (!isNonEmptyString(command.actorId)) return err(invalid("Acknowledgement needs an actor"));
      break;
    case "REPORT_ACTION":
      if (!isNonEmptyString(command.actorId) || !isNonEmptyString(command.actionId)) {
        return err(invalid("Action report needs an actor and an action ID"));
      }
      break;
    case "DISMISS_FALSE_ALARM":
      if (!isNonEmptyString(command.actorId) || !isNonEmptyString(command.reason)) {
        return err(invalid("Dismissal needs an actor and a reason"));
      }
      break;
    case "COMPLETE_VERIFICATION":
      if (
        command.assessment.eventId !== event.eventId ||
        command.assessment.caseId !== event.caseId
      ) {
        return err(
          domainError(
            "VERIFICATION_MISMATCH",
            "RISK_EVENT",
            "Assessment does not belong to this risk event",
          ),
        );
      }
      patch = { latestVerificationId: command.assessment.verificationId };
      break;
    default:
      break;
  }

  const actorId = "actorId" in command ? command.actorId : undefined;
  return ok({
    value: Object.freeze({ ...event, ...patch, state: to, updatedAt: command.at }),
    record: {
      entity: "RISK_EVENT",
      entityId: event.eventId,
      from,
      to,
      command: command.type,
      at: command.at,
      ...(actorId !== undefined && { actorId }),
    },
  });
}

export type CoordinatedResult = {
  readonly case: RiskImprovementCase;
  readonly event: RiskEvent;
  readonly caseRecord: TransitionRecord<CaseState>;
  readonly eventRecord: TransitionRecord<RiskEventState>;
};

/**
 * Applies a verification outcome to the active event and its case together. Both
 * transitions must succeed or nothing is returned. The outcome comes only from a
 * VerificationAssessment; no other input (AI output, button press) can move either state
 * into a verified state.
 */
export function completeVerification(input: {
  readonly case: RiskImprovementCase;
  readonly event: RiskEvent;
  readonly assessment: VerificationAssessment;
  readonly at: IsoTimestamp;
}): Result<CoordinatedResult, DomainError> {
  const { case: c, event, assessment, at } = input;
  if (event.caseId !== c.caseId || event.eventId !== c.activeRiskEventId) {
    return err(
      domainError(
        "VERIFICATION_MISMATCH",
        "CASE",
        "The event is not the active risk event of this case",
      ),
    );
  }
  const eventResult = applyRiskEventCommand(event, {
    type: "COMPLETE_VERIFICATION",
    at,
    assessment,
  });
  if (!eventResult.ok) return eventResult;
  const caseResult = applyCaseCommand(c, { type: "RECORD_VERIFICATION", at, assessment });
  if (!caseResult.ok) return caseResult;
  return ok({
    case: caseResult.value.value,
    event: eventResult.value.value,
    caseRecord: caseResult.value.record,
    eventRecord: eventResult.value.record,
  });
}

/**
 * Reopens a case when the hazard materially returns: the case moves to REOPENED, its
 * recurrenceCount increments and the NEW event (freshly DETECTED) becomes active.
 * Deciding that a recurrence occurred (recurrence monitoring) is S5, not here.
 */
export function reopenOnRecurrence(input: {
  readonly case: RiskImprovementCase;
  readonly newEvent: RiskEvent;
  readonly at: IsoTimestamp;
}): Result<
  { readonly case: RiskImprovementCase; readonly caseRecord: TransitionRecord<CaseState> },
  DomainError
> {
  const { case: c, newEvent, at } = input;
  if (
    newEvent.caseId !== c.caseId ||
    newEvent.organizationId !== c.organizationId ||
    newEvent.state !== "DETECTED"
  ) {
    return err(
      domainError(
        "INVALID_RECURRENCE",
        "CASE",
        "Recurrence requires a new DETECTED event belonging to the same case and organization",
      ),
    );
  }
  const result = applyCaseCommand(c, {
    type: "RECORD_RECURRENCE",
    at,
    newRiskEventId: newEvent.eventId,
  });
  if (!result.ok) return result;
  return ok({ case: result.value.value, caseRecord: result.value.record });
}

/**
 * Case-correlation convention (S3): a hazard episode is identified by organization +
 * facility + hazard type + primary asset. The primary asset is `assetIds[0]` of a case.
 */
export function caseMatchesDetection(c: RiskImprovementCase, d: RiskDetection): boolean {
  return (
    c.organizationId === d.organizationId &&
    c.facilityId === d.facilityId &&
    c.hazardType === d.hazardType &&
    c.assetIds[0] === d.primaryAssetId
  );
}

/** Cases that still represent an unresolved episode; a new detection joins them. */
export function isEpisodeActive(c: RiskImprovementCase): boolean {
  return c.state !== "CLOSED" && c.state !== "VERIFIED_IMPROVED";
}

/**
 * Opens a Risk Improvement Case and its first Risk Event for a first qualifying detection.
 * The case starts OPEN (origin DETECTED_HAZARD) and the event DETECTED; alerting and
 * acknowledgement belong to S4. IDs and the baseline snapshot are supplied by the caller.
 */
export function openCaseFromDetection(input: {
  readonly detection: RiskDetection;
  readonly caseId: string;
  readonly eventId: string;
  readonly baselineSnapshotId: string;
}): Result<{ readonly case: RiskImprovementCase; readonly event: RiskEvent }, DomainError> {
  const { detection: d } = input;
  const assetIds = [d.primaryAssetId, ...d.contextAssetIds.filter((a) => a !== d.primaryAssetId)];
  const event = createRiskEvent({
    eventId: input.eventId,
    caseId: input.caseId,
    organizationId: d.organizationId,
    facilityId: d.facilityId,
    assetIds,
    detectedAt: d.detectedAt,
  });
  if (!event.ok) return event;
  const created = createRiskImprovementCase({
    caseId: input.caseId,
    organizationId: d.organizationId,
    facilityId: d.facilityId,
    assetIds,
    origin: { type: "DETECTED_HAZARD", detectionId: d.detectionId },
    hazardType: d.hazardType,
    title: `${d.hazardType} on ${d.primaryAssetId}`,
    severity: d.severity,
    baselineSnapshotId: input.baselineSnapshotId,
    activeRiskEventId: input.eventId,
    createdAt: d.detectedAt,
  });
  if (!created.ok) return created;
  return ok({ case: created.value, event: event.value });
}
