import { domainError, err, isIsoTimestamp, isNonEmptyString, ok } from "@symbiosis/contracts";
import type {
  ActionStatus,
  DomainError,
  IsoTimestamp,
  MitigationAction,
  Result,
  Transitioned,
} from "@symbiosis/contracts";

/**
 * RECOMMEND_ONLY: this package records human assignment/acknowledgement/reporting. It never
 * controls equipment and never produces verification; a reported completion is evidence of
 * action, not of effectiveness.
 */
export const ACTION_TRANSITIONS: Readonly<Record<ActionStatus, readonly ActionStatus[]>> = {
  ASSIGNED: ["ACKNOWLEDGED", "REPORTED_COMPLETE"],
  ACKNOWLEDGED: ["REPORTED_COMPLETE"],
  REPORTED_COMPLETE: [],
};

export type AssignActionInput = {
  readonly actionId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly actionLibraryId: string;
  readonly assignedTo?: string;
  readonly organizationId?: string;
  readonly assignedBy?: string;
  readonly assignedAt?: string;
  readonly actionLibraryVersion?: string;
};

export function assignMitigationAction(
  input: AssignActionInput,
): Result<MitigationAction, DomainError> {
  const issues: string[] = [];
  for (const key of ["actionId", "caseId", "eventId", "actionLibraryId"] as const) {
    if (!isNonEmptyString(input[key])) issues.push(`${key} is required`);
  }
  if (input.assignedTo !== undefined && !isNonEmptyString(input.assignedTo)) {
    issues.push("assignedTo must be non-empty when provided");
  }
  if (input.assignedAt !== undefined && !isIsoTimestamp(input.assignedAt)) {
    issues.push("assignedAt must be ISO-8601");
  }
  if (issues.length > 0) {
    return err(domainError("INVALID_INPUT", "ACTION", "Invalid mitigation action", { issues }));
  }
  return ok(Object.freeze({ ...input, status: "ASSIGNED" as const }));
}

export type ActionCommand =
  | { readonly type: "ACKNOWLEDGE"; readonly at: IsoTimestamp; readonly actorId: string }
  | {
      readonly type: "REPORT_COMPLETE";
      readonly at: IsoTimestamp;
      readonly reportedBy: string;
      readonly notes?: string;
      readonly attachments?: readonly string[];
    };

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export function applyActionCommand(
  action: MitigationAction,
  command: ActionCommand,
): Result<Transitioned<MitigationAction, ActionStatus>, DomainError> {
  if (!isIsoTimestamp(command.at)) {
    return err(domainError("INVALID_INPUT", "ACTION", "command.at must be ISO-8601"));
  }
  const actorId = command.type === "ACKNOWLEDGE" ? command.actorId : command.reportedBy;
  if (!isNonEmptyString(actorId)) {
    return err(domainError("INVALID_INPUT", "ACTION", "An actor is required for this command"));
  }
  const from = action.status;
  const to: ActionStatus = command.type === "ACKNOWLEDGE" ? "ACKNOWLEDGED" : "REPORTED_COMPLETE";
  if (!canTransitionAction(from, to)) {
    return err(
      domainError(
        "ILLEGAL_ACTION_TRANSITION",
        "ACTION",
        `Illegal action transition ${from} -> ${to}`,
        { from, to },
      ),
    );
  }
  const value: MitigationAction =
    command.type === "ACKNOWLEDGE"
      ? { ...action, status: to, acknowledgedBy: command.actorId, acknowledgedAt: command.at }
      : {
          ...action,
          status: to,
          reportedBy: command.reportedBy,
          reportedAt: command.at,
          ...(command.notes !== undefined && { notes: command.notes }),
          ...(command.attachments !== undefined && { attachments: [...command.attachments] }),
        };
  return ok({
    value: Object.freeze(value),
    record: {
      entity: "ACTION",
      entityId: action.actionId,
      from,
      to,
      command: command.type,
      at: command.at,
      actorId,
    },
  });
}
