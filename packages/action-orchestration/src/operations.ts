import { err, isNonEmptyString, ok } from "@symbiosis/contracts";
import type {
  VerificationAttempt,
  CaseChange,
  CaseState,
  DomainError,
  MitigationAction,
  Result,
  RiskEvent,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { can } from "@symbiosis/authz";
import type { Permission } from "@symbiosis/authz";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";
import type {
  ActionRepository,
  AlertRepository,
  CaseRepository,
  InterventionRepository,
  RiskEventRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import { applyCaseCommand } from "@symbiosis/risk-cases";
import { applyRiskEventCommand } from "@symbiosis/risk-lifecycle";
import { canAccessFacility } from "@symbiosis/tenancy";
import type { ActorContext, ActorDirectory } from "@symbiosis/tenancy";
import { applyActionCommand, assignMitigationAction } from "./actions";
import { actionsFor, findAction } from "./library";
import type { ActionLibrary } from "./library";
import { buildCaseView } from "./view";
import type { CaseView, CaseViewSummary } from "./view";

export type OperationsErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT";

/** NOT_FOUND is also returned for another tenant's case, so IDs cannot be probed. */
export type OperationsError = {
  readonly code: OperationsErrorCode;
  readonly message: string;
  readonly domain?: DomainError;
};

const fail = (code: OperationsErrorCode, message: string, domain?: DomainError) =>
  err<OperationsError>({ code, message, ...(domain !== undefined && { domain }) });

export type OperationsDeps = {
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly actions: ActionRepository;
  readonly alerts: AlertRepository;
  readonly verifications: VerificationRepository;
  readonly interventions: InterventionRepository;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly library: ActionLibrary;
  readonly directory: ActorDirectory;
};

export type ReportActionInput = {
  readonly actionLibraryId: string;
  /** Report a specific assigned action instance; otherwise one is found or created. */
  readonly actionId?: string;
  readonly notes?: string;
  /** Attachment references (IDs) only; blobs are never accepted here. */
  readonly attachments?: readonly string[];
};

export type WorkflowOutcome = {
  readonly caseId: string;
  readonly riskEventId: string;
  readonly caseState: CaseState;
  readonly riskEventState: RiskEvent["state"];
  readonly actionId?: string;
};

export interface Operations {
  acknowledgeCase(
    actor: ActorContext,
    caseId: string,
    note?: string,
  ): Promise<Result<WorkflowOutcome, OperationsError>>;
  assignAction(
    actor: ActorContext,
    caseId: string,
    input: { readonly actionLibraryId: string; readonly assigneeId: string },
  ): Promise<Result<WorkflowOutcome, OperationsError>>;
  acknowledgeAction(
    actor: ActorContext,
    caseId: string,
    actionId: string,
  ): Promise<Result<WorkflowOutcome, OperationsError>>;
  reportAction(
    actor: ActorContext,
    caseId: string,
    input: ReportActionInput,
  ): Promise<Result<WorkflowOutcome, OperationsError>>;
  dismissCase(
    actor: ActorContext,
    caseId: string,
    reason: string,
  ): Promise<Result<WorkflowOutcome, OperationsError>>;
  getCaseView(actor: ActorContext, caseId: string): Promise<Result<CaseView, OperationsError>>;
  /** One verification attempt (with its assessment, criteria and evidence references). */
  getVerification(
    actor: ActorContext,
    verificationId: string,
  ): Promise<Result<VerificationAttempt, OperationsError>>;
  listCases(actor: ActorContext): Promise<Result<readonly CaseViewSummary[], OperationsError>>;
}

const laterIso = (...isos: string[]) =>
  new Date(Math.max(...isos.map((i) => Date.parse(i)))).toISOString();

/**
 * Risk-event states from which a human may assign or report an approved action: the first cycle
 * (ACKNOWLEDGED), further actions while waiting (ACTION_REPORTED) and a follow-up cycle after an
 * unsuccessful verification outcome. Outcome states are never silently closed (S5).
 */
const ACTIONABLE_EVENT_STATES: readonly RiskEvent["state"][] = [
  "ACKNOWLEDGED",
  "ACTION_REPORTED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
];
/** Case states that move to ACTION_REQUIRED when an action is assigned or reported. */
const CASE_NEEDS_REQUIRE_ACTION: readonly CaseState[] = [
  "OPEN",
  "REOPENED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
];

const MAX_NOTE = 2000;
const MAX_ATTACHMENTS = 10;

/**
 * Operations workflow application service. HTTP routes call this and nothing else; every
 * lifecycle rule lives in the S1 domain (risk-lifecycle / risk-cases / action state machine).
 * Each command computes ALL resulting state first and persists only if every part succeeded,
 * so a failure never leaves an action complete while the event or case disagrees.
 *
 * Invariant: nothing here can produce a verification outcome. Reporting an action moves the
 * event and case to ACTION_REPORTED and nothing further; only the verification runner, over
 * trusted sensor observations, can move them on (S5).
 */
export function createOperations(deps: OperationsDeps): Operations {
  async function loadCase(
    actor: ActorContext,
    caseId: string,
    permission: Permission,
  ): Promise<Result<RiskImprovementCase, OperationsError>> {
    if (!can(actor, permission)) return fail("FORBIDDEN", `Missing permission ${permission}`);
    const c = await deps.cases.get(actor.organizationId, caseId);
    if (c === undefined || !canAccessFacility(actor, c.facilityId)) {
      return fail("NOT_FOUND", "Case not found");
    }
    return ok(c);
  }

  async function loadEvent(c: RiskImprovementCase): Promise<Result<RiskEvent, OperationsError>> {
    const event =
      c.activeRiskEventId === undefined
        ? undefined
        : await deps.riskEvents.get(c.organizationId, c.activeRiskEventId);
    return event === undefined ? fail("CONFLICT", "The case has no active risk event") : ok(event);
  }

  async function audit(
    actor: ActorContext,
    c: RiskImprovementCase,
    entry: {
      action: Parameters<AuditLog["append"]>[0]["action"];
      targetType: "CASE" | "RISK_EVENT" | "ACTION";
      targetId: string;
      before?: string;
      after?: string;
      at: string;
      correlationId: string;
      details?: Parameters<AuditLog["append"]>[0]["details"];
    },
  ) {
    await deps.audit.append({
      organizationId: c.organizationId,
      facilityId: c.facilityId,
      caseId: c.caseId,
      actorId: actor.actorId,
      actorType: "USER",
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      ...(entry.before !== undefined && { beforeState: entry.before }),
      ...(entry.after !== undefined && { afterState: entry.after }),
      correlationId: entry.correlationId,
      at: entry.at,
      ...(entry.details !== undefined && { details: entry.details }),
    });
  }

  const base = (c: RiskImprovementCase, correlationId: string) => ({
    correlationId,
    causationId: null,
    organizationId: c.organizationId,
    facilityId: c.facilityId,
    occurredAt: nowIso(deps.clock),
    producer: "api" as const,
  });

  async function publishCaseUpdated(
    c: RiskImprovementCase,
    next: RiskImprovementCase,
    change: CaseChange,
    correlationId: string,
    actionId?: string,
  ) {
    await deps.bus.publish(
      createEnvelope(deps.ids, {
        ...base(next, correlationId),
        type: "case.updated.v1",
        payload: {
          caseId: next.caseId,
          riskEventId: next.activeRiskEventId ?? "",
          change,
          state: next.state,
          previousState: c.state,
          severity: next.severity,
          previousSeverity: c.severity,
          ...(actionId !== undefined && { actionId }),
        },
      }),
    );
  }

  const outcome = (
    c: RiskImprovementCase,
    event: RiskEvent,
    actionId?: string,
  ): WorkflowOutcome => ({
    caseId: c.caseId,
    riskEventId: event.eventId,
    caseState: c.state,
    riskEventState: event.state,
    ...(actionId !== undefined && { actionId }),
  });

  function checkLibrary(c: RiskImprovementCase, actionLibraryId: string) {
    const entry =
      typeof actionLibraryId === "string" ? findAction(deps.library, actionLibraryId) : undefined;
    if (entry === undefined) {
      return fail("INVALID_REQUEST", "actionLibraryId is not an approved action");
    }
    if (!actionsFor(deps.library, c.hazardType).includes(entry)) {
      return fail("INVALID_REQUEST", "That approved action does not apply to this hazard");
    }
    return ok(entry);
  }

  return {
    async acknowledgeCase(actor, caseId, note) {
      if (note !== undefined && (typeof note !== "string" || note.length > 500)) {
        return fail("INVALID_REQUEST", "note must be a string of at most 500 characters");
      }
      const lc = await loadCase(actor, caseId, "CASE_ACKNOWLEDGE");
      if (!lc.ok) return lc;
      const le = await loadEvent(lc.value);
      if (!le.ok) return le;
      const c = lc.value;
      const event = le.value;
      const at = laterIso(nowIso(deps.clock), event.updatedAt);
      const t = applyRiskEventCommand(event, { type: "ACKNOWLEDGE", at, actorId: actor.actorId });
      if (!t.ok) {
        return fail(
          "CONFLICT",
          `Cannot acknowledge while the risk event is ${event.state}`,
          t.error,
        );
      }
      const correlationId = deps.ids.next("CORR");
      await deps.riskEvents.save(t.value.value);
      await audit(actor, c, {
        action: "RISK_ACKNOWLEDGED",
        targetType: "RISK_EVENT",
        targetId: event.eventId,
        before: event.state,
        after: "ACKNOWLEDGED",
        at,
        correlationId,
        ...(note !== undefined && { details: { note } }),
      });
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base(c, correlationId),
          type: "risk.acknowledged.v1",
          payload: {
            caseId: c.caseId,
            riskEventId: event.eventId,
            actorId: actor.actorId,
            acknowledgedAt: at,
            ...(note !== undefined && { note }),
          },
        }),
      );
      // Acknowledgement is accountability only: the case and every action are untouched.
      return ok(outcome(c, t.value.value));
    },

    async assignAction(actor, caseId, input) {
      const lc = await loadCase(actor, caseId, "ACTION_ASSIGN");
      if (!lc.ok) return lc;
      const lib = checkLibrary(lc.value, input?.actionLibraryId);
      if (!lib.ok) return lib;
      const le = await loadEvent(lc.value);
      if (!le.ok) return le;
      const c = lc.value;
      const event = le.value;
      if (!ACTIONABLE_EVENT_STATES.includes(event.state)) {
        return fail(
          "CONFLICT",
          `Acknowledge the risk before assigning actions (event is ${event.state})`,
        );
      }
      const assignee = isNonEmptyString(input.assigneeId)
        ? await deps.directory.get(input.assigneeId)
        : undefined;
      if (
        assignee === undefined ||
        assignee.organizationId !== c.organizationId ||
        !canAccessFacility(assignee, c.facilityId)
      ) {
        return fail("INVALID_REQUEST", "assigneeId is not a member of this facility");
      }
      const at = laterIso(nowIso(deps.clock), c.updatedAt, event.updatedAt);
      const created = assignMitigationAction({
        actionId: deps.ids.next("ACT"),
        caseId: c.caseId,
        eventId: event.eventId,
        actionLibraryId: lib.value.actionLibraryId,
        assignedTo: assignee.actorId,
        organizationId: c.organizationId,
        assignedBy: actor.actorId,
        assignedAt: at,
        actionLibraryVersion: deps.library.version,
      });
      if (!created.ok) return fail("INVALID_REQUEST", created.error.message, created.error);

      let next = c;
      if (CASE_NEEDS_REQUIRE_ACTION.includes(c.state)) {
        const r = applyCaseCommand(c, {
          type: "REQUIRE_ACTION",
          at,
          riskEventId: event.eventId,
          ownerId: assignee.actorId,
        });
        if (!r.ok) return fail("CONFLICT", r.error.message, r.error);
        next = r.value.value;
      }
      const correlationId = deps.ids.next("CORR");
      await deps.actions.save(c.organizationId, created.value);
      if (next !== c) await deps.cases.save(next);
      await audit(actor, c, {
        action: "ACTION_ASSIGNED",
        targetType: "ACTION",
        targetId: created.value.actionId,
        after: "ASSIGNED",
        at,
        correlationId,
        details: { actionLibraryId: lib.value.actionLibraryId, assignedTo: assignee.actorId },
      });
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base(c, correlationId),
          type: "action.assigned.v1",
          payload: {
            actionId: created.value.actionId,
            caseId: c.caseId,
            riskEventId: event.eventId,
            actionLibraryId: lib.value.actionLibraryId,
            actionLibraryVersion: deps.library.version,
            assignedTo: assignee.actorId,
            assignedBy: actor.actorId,
            assignedAt: at,
          },
        }),
      );
      if (next !== c)
        await publishCaseUpdated(c, next, "ACTION_REQUIRED", correlationId, created.value.actionId);
      return ok(outcome(next, event, created.value.actionId));
    },

    async acknowledgeAction(actor, caseId, actionId) {
      const lc = await loadCase(actor, caseId, "ACTION_ACKNOWLEDGE");
      if (!lc.ok) return lc;
      const c = lc.value;
      const action = await deps.actions.get(c.organizationId, actionId);
      if (action === undefined || action.caseId !== c.caseId)
        return fail("NOT_FOUND", "Action not found");
      if (action.assignedTo !== actor.actorId) {
        return fail("FORBIDDEN", "Only the assignee can acknowledge responsibility for an action");
      }
      const le = await loadEvent(c);
      if (!le.ok) return le;
      const at = laterIso(nowIso(deps.clock), action.assignedAt ?? c.updatedAt);
      const t = applyActionCommand(action, { type: "ACKNOWLEDGE", at, actorId: actor.actorId });
      if (!t.ok)
        return fail("CONFLICT", `Cannot acknowledge an action that is ${action.status}`, t.error);
      const correlationId = deps.ids.next("CORR");
      await deps.actions.save(c.organizationId, t.value.value);
      await audit(actor, c, {
        action: "ACTION_ACKNOWLEDGED",
        targetType: "ACTION",
        targetId: action.actionId,
        before: action.status,
        after: "ACKNOWLEDGED",
        at,
        correlationId,
      });
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base(c, correlationId),
          type: "action.acknowledged.v1",
          payload: {
            actionId: action.actionId,
            caseId: c.caseId,
            actorId: actor.actorId,
            acknowledgedAt: at,
          },
        }),
      );
      // Operational acknowledgement only: no case or event change, no physical conclusion.
      return ok(outcome(c, le.value, action.actionId));
    },

    async reportAction(actor, caseId, input) {
      const lc = await loadCase(actor, caseId, "ACTION_REPORT");
      if (!lc.ok) return lc;
      const c = lc.value;
      const lib = checkLibrary(c, input?.actionLibraryId);
      if (!lib.ok) return lib;
      const { notes, attachments } = input;
      if (notes !== undefined && (typeof notes !== "string" || notes.length > MAX_NOTE)) {
        return fail("INVALID_REQUEST", `notes must be a string of at most ${MAX_NOTE} characters`);
      }
      if (
        attachments !== undefined &&
        (!Array.isArray(attachments) ||
          attachments.length > MAX_ATTACHMENTS ||
          !attachments.every((a) => typeof a === "string" && a.length > 0 && a.length <= 128))
      ) {
        return fail(
          "INVALID_REQUEST",
          `attachments must be at most ${MAX_ATTACHMENTS} reference IDs`,
        );
      }
      const le = await loadEvent(c);
      if (!le.ok) return le;
      const event = le.value;
      if (!ACTIONABLE_EVENT_STATES.includes(event.state)) {
        return fail(
          "CONFLICT",
          `Acknowledge the risk before reporting an action (event is ${event.state})`,
        );
      }

      const existing = await deps.actions.listByCase(c.organizationId, c.caseId);
      let action: MitigationAction | undefined;
      if (input.actionId !== undefined) {
        action = existing.find((a) => a.actionId === input.actionId);
        if (action === undefined || action.eventId !== event.eventId) {
          return fail("NOT_FOUND", "Action not found for this case and risk event");
        }
        if (action.actionLibraryId !== lib.value.actionLibraryId) {
          return fail("INVALID_REQUEST", "actionLibraryId does not match the assigned action");
        }
      } else {
        action = existing.find(
          (a) =>
            a.actionLibraryId === lib.value.actionLibraryId &&
            a.eventId === event.eventId &&
            a.status !== "REPORTED_COMPLETE",
        );
      }
      const at = laterIso(nowIso(deps.clock), c.updatedAt, event.updatedAt);
      if (action === undefined) {
        const created = assignMitigationAction({
          actionId: deps.ids.next("ACT"),
          caseId: c.caseId,
          eventId: event.eventId,
          actionLibraryId: lib.value.actionLibraryId,
          assignedTo: actor.actorId,
          organizationId: c.organizationId,
          assignedBy: actor.actorId,
          assignedAt: at,
          actionLibraryVersion: deps.library.version,
        });
        if (!created.ok) return fail("INVALID_REQUEST", created.error.message, created.error);
        action = created.value;
      }

      // 1. compute every resulting state; nothing is persisted until all of it succeeds
      const reported = applyActionCommand(action, {
        type: "REPORT_COMPLETE",
        at,
        reportedBy: actor.actorId,
        ...(notes !== undefined && { notes }),
        ...(attachments !== undefined && { attachments }),
      });
      if (!reported.ok) {
        return fail("CONFLICT", `Action already ${action.status}`, reported.error);
      }
      let nextEvent = event;
      if (event.state !== "ACTION_REPORTED") {
        const t = applyRiskEventCommand(event, {
          type: "REPORT_ACTION",
          at,
          actorId: actor.actorId,
          actionId: action.actionId,
        });
        if (!t.ok) return fail("CONFLICT", t.error.message, t.error);
        nextEvent = t.value.value;
      }
      let nextCase = c;
      if (CASE_NEEDS_REQUIRE_ACTION.includes(nextCase.state)) {
        const r = applyCaseCommand(nextCase, {
          type: "REQUIRE_ACTION",
          at,
          riskEventId: event.eventId,
          ownerId: actor.actorId,
        });
        if (!r.ok) return fail("CONFLICT", r.error.message, r.error);
        nextCase = r.value.value;
      }
      if (nextCase.state === "ACTION_REQUIRED") {
        const r = applyCaseCommand(nextCase, {
          type: "REPORT_ACTION",
          at,
          actionId: action.actionId,
          actorId: actor.actorId,
        });
        if (!r.ok) return fail("CONFLICT", r.error.message, r.error);
        nextCase = r.value.value;
      } else if (nextCase.state !== "ACTION_REPORTED") {
        return fail("CONFLICT", `Cannot report an action while the case is ${nextCase.state}`);
      }

      // 2. persist and publish
      const correlationId = deps.ids.next("CORR");
      await deps.actions.save(c.organizationId, reported.value.value);
      if (nextEvent !== event) await deps.riskEvents.save(nextEvent);
      if (nextCase !== c) await deps.cases.save(nextCase);
      const reportedEvent = createEnvelope(deps.ids, {
        ...base(c, correlationId),
        type: "action.reported.v1",
        payload: {
          actionId: action.actionId,
          caseId: c.caseId,
          riskEventId: event.eventId,
          actionLibraryId: lib.value.actionLibraryId,
          reportedBy: actor.actorId,
          reportedAt: at,
          hasNotes: notes !== undefined && notes.length > 0,
          attachmentCount: attachments?.length ?? 0,
        },
      });
      await audit(actor, c, {
        action: "ACTION_REPORTED",
        targetType: "ACTION",
        targetId: action.actionId,
        before: action.status,
        after: "REPORTED_COMPLETE",
        at,
        correlationId,
        details: {
          actionLibraryId: lib.value.actionLibraryId,
          eventState: nextEvent.state,
          caseState: nextCase.state,
          attachmentCount: attachments?.length ?? 0,
          // lets the verification that follows keep causation to this event
          emittedEventId: reportedEvent.event_id,
        },
      });
      await deps.bus.publish(reportedEvent);
      if (nextCase !== c)
        await publishCaseUpdated(c, nextCase, "ACTION_REPORTED", correlationId, action.actionId);
      return ok(outcome(nextCase, nextEvent, action.actionId));
    },

    async dismissCase(actor, caseId, reason) {
      if (!isNonEmptyString(reason) || reason.length > 500) {
        return fail("INVALID_REQUEST", "A dismissal reason (at most 500 characters) is required");
      }
      const lc = await loadCase(actor, caseId, "RISK_DISMISS");
      if (!lc.ok) return lc;
      const le = await loadEvent(lc.value);
      if (!le.ok) return le;
      const c = lc.value;
      const event = le.value;
      const at = laterIso(nowIso(deps.clock), c.updatedAt, event.updatedAt);
      const t = applyRiskEventCommand(event, {
        type: "DISMISS_FALSE_ALARM",
        at,
        actorId: actor.actorId,
        reason,
      });
      if (!t.ok)
        return fail("CONFLICT", `Cannot dismiss while the risk event is ${event.state}`, t.error);
      const closed = applyCaseCommand(c, { type: "CLOSE", at, actorId: actor.actorId, reason });
      if (!closed.ok) return fail("CONFLICT", closed.error.message, closed.error);
      const correlationId = deps.ids.next("CORR");
      await deps.riskEvents.save(t.value.value);
      await deps.cases.save(closed.value.value);
      await audit(actor, c, {
        action: "RISK_DISMISSED",
        targetType: "RISK_EVENT",
        targetId: event.eventId,
        before: event.state,
        after: "DISMISSED_FALSE_ALARM",
        at,
        correlationId,
        details: { reason },
      });
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          ...base(c, correlationId),
          type: "risk.dismissed.v1",
          payload: {
            caseId: c.caseId,
            riskEventId: event.eventId,
            actorId: actor.actorId,
            dismissedAt: at,
            reason,
          },
        }),
      );
      await publishCaseUpdated(c, closed.value.value, "CASE_CLOSED", correlationId);
      return ok(outcome(closed.value.value, t.value.value));
    },

    async getCaseView(actor, caseId) {
      const lc = await loadCase(actor, caseId, "CASE_READ");
      if (!lc.ok) return lc;
      const c = lc.value;
      const [event, actions, alerts, auditEntries, attempts, interventions] = await Promise.all([
        c.activeRiskEventId
          ? deps.riskEvents.get(c.organizationId, c.activeRiskEventId)
          : undefined,
        deps.actions.listByCase(c.organizationId, c.caseId),
        deps.alerts.listByCase(c.organizationId, c.caseId),
        deps.audit.listByCase(c.organizationId, c.caseId),
        deps.verifications.listByCase(c.organizationId, c.caseId),
        deps.interventions.listByCase(c.organizationId, c.caseId),
      ]);
      return ok(
        buildCaseView({
          caseRecord: c,
          ...(event !== undefined && { event }),
          actions,
          alerts,
          audit: auditEntries,
          verifications: attempts,
          interventions,
          library: deps.library,
        }),
      );
    },

    async getVerification(actor, verificationId) {
      if (!can(actor, "CASE_READ")) return fail("FORBIDDEN", "Missing permission CASE_READ");
      const attempt = await deps.verifications.get(actor.organizationId, verificationId);
      if (attempt === undefined || !canAccessFacility(actor, attempt.facilityId)) {
        return fail("NOT_FOUND", "Verification not found");
      }
      return ok(attempt);
    },

    async listCases(actor) {
      if (!can(actor, "CASE_READ")) return fail("FORBIDDEN", "Missing permission CASE_READ");
      const all = await deps.cases.list(actor.organizationId);
      const rows: CaseViewSummary[] = [];
      for (const c of all.filter((x) => canAccessFacility(actor, x.facilityId))) {
        const v = await this.getCaseView(actor, c.caseId);
        if (v.ok) {
          rows.push({
            caseId: v.value.caseId,
            title: v.value.title,
            severity: v.value.severity,
            state: v.value.state,
            ...(v.value.riskEventState !== undefined && { riskEventState: v.value.riskEventState }),
            facilityId: v.value.facilityId,
            didItWork: v.value.didItWork.label,
            createdAt: c.createdAt,
          });
        }
      }
      return ok(rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    },
  };
}
