import type {
  Alert,
  AlertKind,
  AlertTrigger,
  NotificationDelivery,
  NotificationRequest,
  NotificationResult,
  RiskEvent,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { EscalationPolicy } from "@symbiosis/escalation";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type { AlertRepository, CaseRepository, RiskEventRepository } from "@symbiosis/repositories";
import { applyRiskEventCommand } from "@symbiosis/risk-lifecycle";
import type { ActorDirectory, Role } from "@symbiosis/tenancy";
import { composeAlert } from "./compose";
import type { AlertComposeExtras } from "./compose";
import { deliveryIdFor } from "./deliveries";
import type { DeliveryStore } from "./deliveries";
import type { NotificationSender } from "./sender";

/** Facts about the surroundings of an alert (names, links, actions, verification digest). */
export type AlertContextProvider = (input: {
  readonly caseRecord: RiskImprovementCase;
  readonly alert: Alert;
}) => Promise<AlertComposeExtras>;

export type AlertingDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly alerts: AlertRepository;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly audit: AuditLog;
  readonly directory: ActorDirectory;
  readonly sender: NotificationSender;
  /** Fixed in production; the simulation tenant resolves its versioned policy (D-092). */
  readonly policy:
    | EscalationPolicy
    | ((
        organizationId: string,
        facilityId: string,
      ) => EscalationPolicy | Promise<EscalationPolicy>);
  /** Persisted delivery attempts: the idempotency record (D-090). */
  readonly deliveries: DeliveryStore;
  readonly context?: AlertContextProvider;
  /** An attempt reserved and never completed for this long is treated as interrupted. Default 120. */
  readonly pendingTimeoutSeconds?: number;
};

export type Alerting = {
  /** Requests (and attempts to deliver) the alert of a kind for a risk event. Idempotent. */
  requestAlert(input: {
    readonly caseRecord: RiskImprovementCase;
    readonly event: RiskEvent;
    readonly kind: AlertKind;
    readonly correlationId: string;
    readonly causationId: string | null;
    readonly reasonCodes?: readonly string[];
    /** Why this communication exists (follow-ups; the recurrence INITIAL alert). */
    readonly trigger?: AlertTrigger;
    /** Overrides the policy's recipient role (follow-up policy decides per trigger). */
    readonly recipientRole?: Role;
  }): Promise<Alert>;
  /**
   * Re-attempts failed, non-exhausted alerts whose retry time has come, and repairs attempts that were
   * interrupted between reserving and completing.
   */
  retryDueAlerts(): Promise<number>;
};

const laterIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/** `ALR-<event>-INITIAL`, `ALR-<event>-ESCALATION`, `ALR-<event>-FOLLOW_UP-<reference>`. */
export function alertIdFor(eventId: string, kind: AlertKind, trigger?: AlertTrigger): string {
  return kind === "FOLLOW_UP" && trigger !== undefined
    ? `ALR-${eventId}-${kind}-${trigger.referenceId}`
    : `ALR-${eventId}-${kind}`;
}

/**
 * Alert lifecycle rule (D-030): the risk event becomes ALERTED only when the configured
 * notification channel returns SENT for the INITIAL alert. Constructing or requesting an alert
 * changes nothing; a FAILED attempt keeps the event DETECTED and records the failure, then
 * retries on a fixed interval up to `maxDeliveryAttempts`. A failure the channel marks permanent
 * (a bad address, rejected credentials) is never retried. If every attempt fails the alert is
 * exhausted, and the escalation tick escalates the still-DETECTED event to a human.
 *
 * Idempotency (D-090): every attempt first creates a delivery record keyed `alertId#attempt` with an
 * atomic create. Only the caller that created it sends, so a redelivered event, a duplicate
 * Pub/Sub message or a concurrent worker can never produce a second send for the same attempt.
 */
export function createAlerting(deps: AlertingDeps): Alerting {
  const emit = <T extends string, P>(
    type: T,
    payload: P,
    ctx: { org: string; fac: string; correlationId: string; causationId: string | null },
  ) =>
    createEnvelope(deps.ids, {
      type,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      organizationId: ctx.org,
      facilityId: ctx.fac,
      occurredAt: nowIso(deps.clock),
      producer: "worker" as const,
      payload,
    });

  const policyFor = async (org: string, fac: string): Promise<EscalationPolicy> =>
    typeof deps.policy === "function" ? deps.policy(org, fac) : deps.policy;

  async function composeFor(alert: Alert, caseRecord: RiskImprovementCase | undefined) {
    if (caseRecord === undefined) {
      return { subject: `[ALERT] [${alert.severity}] ${alert.hazardType}`, body: alert.summary };
    }
    const extras = (await deps.context?.({ caseRecord, alert })) ?? {};
    return composeAlert({
      caseRecord,
      kind: alert.kind,
      reasonCodes: alert.reasonCodes,
      casePath: `/ui/cases/${alert.caseId}`,
      ...(alert.trigger !== undefined && { trigger: alert.trigger }),
      extras,
    });
  }

  async function deliver(alert: Alert, causationId: string | null): Promise<Alert> {
    const ctx = {
      org: alert.organizationId,
      fac: alert.facilityId,
      correlationId: alert.correlationId,
    };
    const caseRecord = await deps.cases.get(alert.organizationId, alert.caseId);
    const previous = await deps.deliveries.listByAlert(alert.organizationId, alert.alertId);
    const attemptNo = previous.length + 1;
    const requestedAt = nowIso(deps.clock);
    const composed = await composeFor(alert, caseRecord);
    const notificationId = deps.ids.next("NTF");

    // The single point of idempotency: only the caller that creates this record may send.
    const pending: NotificationDelivery = {
      deliveryId: deliveryIdFor(alert.alertId, attemptNo),
      notificationId,
      organizationId: alert.organizationId,
      facilityId: alert.facilityId,
      alertId: alert.alertId,
      alertKind: alert.kind,
      caseId: alert.caseId,
      riskEventId: alert.riskEventId,
      recipientRef: alert.recipient.ref,
      ...(alert.recipient.role !== undefined && { recipientRole: alert.recipient.role }),
      channel: alert.channel,
      attempt: attemptNo,
      status: "PENDING",
      subject: composed.subject,
      requestedAt,
    };
    if (!(await deps.deliveries.reserve(pending))) return alert;

    const request: NotificationRequest = {
      notificationId,
      organizationId: alert.organizationId,
      facilityId: alert.facilityId,
      channel: alert.channel,
      recipient: alert.recipient,
      subject: composed.subject,
      body: composed.body,
      caseId: alert.caseId,
      riskEventId: alert.riskEventId,
      severity: alert.severity,
      requestedAt,
      kind: alert.kind,
    };
    const requested = emit(
      "notification.requested.v1",
      {
        notificationId,
        alertId: alert.alertId,
        alertKind: alert.kind,
        caseId: alert.caseId,
        riskEventId: alert.riskEventId,
        channel: alert.channel,
        recipientRef: alert.recipient.ref,
        subject: request.subject,
        attempt: attemptNo,
        requestedAt,
      },
      { ...ctx, causationId },
    );
    await deps.bus.publish(requested);

    let result: NotificationResult;
    if (alert.recipient.ref === "UNASSIGNED") {
      result = {
        notificationId,
        status: "FAILED",
        channel: alert.channel,
        recipientRef: alert.recipient.ref,
        requestedAt,
        completedAt: nowIso(deps.clock),
        failure: { code: "NO_RECIPIENT", message: "no actor holds the configured role" },
      };
    } else {
      try {
        result = await deps.sender.send(request);
      } catch (error) {
        result = {
          notificationId,
          status: "FAILED",
          channel: alert.channel,
          recipientRef: alert.recipient.ref,
          requestedAt,
          completedAt: nowIso(deps.clock),
          failure: { code: "SENDER_ERROR", message: (error as Error).message },
        };
      }
    }
    await deps.deliveries.complete({
      ...pending,
      status: result.status,
      completedAt: result.completedAt,
      ...(result.addressHint !== undefined && { addressHint: result.addressHint }),
      ...(result.failure !== undefined && {
        failure: {
          code: result.failure.code,
          message: result.failure.message.slice(0, 200),
          retryable: result.failure.retryable !== false,
        },
      }),
    });

    const attempts = [...alert.attempts, result];
    if (result.status === "SENT") {
      const sent: Alert = {
        ...alert,
        status: "SENT",
        attempts,
        exhausted: false,
        sentAt: result.completedAt,
      };
      delete (sent as { nextRetryAt?: string }).nextRetryAt;
      await deps.alerts.save(sent);
      await deps.audit.append({
        organizationId: alert.organizationId,
        facilityId: alert.facilityId,
        caseId: alert.caseId,
        actorId: "SYSTEM-ALERTING",
        actorType: "SYSTEM",
        action: "ALERT_SENT",
        targetType: "ALERT",
        targetId: alert.alertId,
        beforeState: alert.status,
        afterState: "SENT",
        correlationId: alert.correlationId,
        at: result.completedAt,
        details: {
          attempt: attemptNo,
          channel: result.channel,
          recipient: result.recipientRef,
          kind: alert.kind,
        },
      });
      const sentEvent = emit(
        "notification.sent.v1",
        {
          alertId: alert.alertId,
          alertKind: alert.kind,
          caseId: alert.caseId,
          riskEventId: alert.riskEventId,
          attempt: attemptNo,
          result,
        },
        { ...ctx, causationId: requested.event_id },
      );
      await deps.bus.publish(sentEvent);

      if (alert.kind === "INITIAL") {
        const event = await deps.riskEvents.get(alert.organizationId, alert.riskEventId);
        if (event !== undefined && event.state === "DETECTED") {
          const at = laterIso(result.completedAt, event.updatedAt);
          const alerted = applyRiskEventCommand(event, { type: "ALERT", at });
          if (alerted.ok) {
            await deps.riskEvents.save(alerted.value.value);
            await deps.audit.append({
              organizationId: alert.organizationId,
              facilityId: alert.facilityId,
              caseId: alert.caseId,
              actorId: "SYSTEM-ALERTING",
              actorType: "SYSTEM",
              action: "RISK_ALERTED",
              targetType: "RISK_EVENT",
              targetId: event.eventId,
              beforeState: "DETECTED",
              afterState: "ALERTED",
              correlationId: alert.correlationId,
              at,
            });
            await deps.bus.publish(
              emit(
                "risk.alerted.v1",
                {
                  alertId: alert.alertId,
                  caseId: alert.caseId,
                  riskEventId: event.eventId,
                  alertedAt: at,
                },
                { ...ctx, causationId: sentEvent.event_id },
              ),
            );
          }
        }
      }
      return sent;
    }

    const permanent = result.failure?.retryable === false;
    const exhausted = permanent || attempts.length >= alert.maxAttempts;
    const policy = await policyFor(alert.organizationId, alert.facilityId);
    const nextRetryAt = exhausted
      ? undefined
      : new Date(
          Date.parse(result.completedAt) + policy.alert.retryIntervalSeconds * 1000,
        ).toISOString();
    const failed: Alert = {
      ...alert,
      status: "FAILED",
      attempts,
      exhausted,
      ...(nextRetryAt !== undefined && { nextRetryAt }),
    };
    if (nextRetryAt === undefined) delete (failed as { nextRetryAt?: string }).nextRetryAt;
    await deps.alerts.save(failed);
    await deps.audit.append({
      organizationId: alert.organizationId,
      facilityId: alert.facilityId,
      caseId: alert.caseId,
      actorId: "SYSTEM-ALERTING",
      actorType: "SYSTEM",
      action: "ALERT_FAILED",
      targetType: "ALERT",
      targetId: alert.alertId,
      beforeState: alert.status,
      afterState: "FAILED",
      correlationId: alert.correlationId,
      at: result.completedAt,
      details: {
        attempt: attemptNo,
        code: result.failure?.code ?? "UNKNOWN",
        exhausted,
        retryable: !permanent,
        kind: alert.kind,
      },
    });
    await deps.bus.publish(
      emit(
        "notification.failed.v1",
        {
          alertId: alert.alertId,
          alertKind: alert.kind,
          caseId: alert.caseId,
          riskEventId: alert.riskEventId,
          attempt: attemptNo,
          result,
          ...(nextRetryAt !== undefined && { nextRetryAt }),
        },
        { ...ctx, causationId: requested.event_id },
      ),
    );
    return failed;
  }

  return {
    async requestAlert(input) {
      const { caseRecord, event, kind } = input;
      const alertId = alertIdFor(event.eventId, kind, input.trigger);
      const existing = await deps.alerts.get(caseRecord.organizationId, alertId);
      if (existing !== undefined) {
        // A redelivered event: never a second alert. If the first attempt never started (a crash
        // right after the alert was saved), start it now; the delivery record still guards it.
        return existing.status === "REQUESTED" && existing.attempts.length === 0
          ? deliver(existing, input.causationId)
          : existing;
      }

      const policy = await policyFor(caseRecord.organizationId, caseRecord.facilityId);
      const role: Role =
        input.recipientRole ??
        (kind === "ESCALATION"
          ? policy.alert.escalationRecipientRole
          : policy.alert.initialRecipientRole);
      const recipient = await deps.directory.findByRole(
        caseRecord.organizationId,
        caseRecord.facilityId,
        role,
      );
      // Escalations reuse the facts of the initial alert (same deterministic reason codes).
      const reasonCodes =
        input.reasonCodes ??
        (await deps.alerts.listByCase(caseRecord.organizationId, caseRecord.caseId)).find(
          (a) => a.kind === "INITIAL",
        )?.reasonCodes ??
        [];
      const composed = composeAlert({
        caseRecord,
        kind,
        reasonCodes,
        casePath: `/ui/cases/${caseRecord.caseId}`,
        ...(input.trigger !== undefined && { trigger: input.trigger }),
      });
      const alert: Alert = {
        alertId,
        organizationId: caseRecord.organizationId,
        facilityId: caseRecord.facilityId,
        caseId: caseRecord.caseId,
        riskEventId: event.eventId,
        kind,
        severity: caseRecord.severity,
        hazardType: caseRecord.hazardType,
        reasonCodes,
        summary: composed.summary,
        recipient: { ref: recipient?.actorId ?? "UNASSIGNED", role },
        // The channel is whatever the composition root wired: the sender is the truth.
        channel: deps.sender.channel,
        status: "REQUESTED",
        attempts: [],
        maxAttempts: policy.alert.maxDeliveryAttempts,
        exhausted: false,
        requestedAt: nowIso(deps.clock),
        correlationId: input.correlationId,
        ...(input.trigger !== undefined && { trigger: input.trigger }),
      };
      await deps.alerts.save(alert);
      await deps.audit.append({
        organizationId: alert.organizationId,
        facilityId: alert.facilityId,
        caseId: alert.caseId,
        actorId: "SYSTEM-ALERTING",
        actorType: "SYSTEM",
        action: "ALERT_REQUESTED",
        targetType: "ALERT",
        targetId: alertId,
        afterState: "REQUESTED",
        correlationId: alert.correlationId,
        at: alert.requestedAt,
        details: {
          kind,
          recipientRole: role,
          ...(input.trigger !== undefined && {
            trigger: input.trigger.type,
            triggerReference: input.trigger.referenceId,
          }),
        },
      });
      const requestedEvent = emit(
        "risk.alert_requested.v1",
        {
          alertId,
          organizationId: alert.organizationId,
          facilityId: alert.facilityId,
          caseId: alert.caseId,
          riskEventId: alert.riskEventId,
          kind,
          severity: alert.severity,
          hazardType: alert.hazardType,
          reasonCodes,
          summary: alert.summary,
          recipient: alert.recipient,
          channel: alert.channel,
          maxAttempts: alert.maxAttempts,
          requestedAt: alert.requestedAt,
          correlationId: alert.correlationId,
        },
        {
          org: alert.organizationId,
          fac: alert.facilityId,
          correlationId: input.correlationId,
          causationId: input.causationId,
        },
      );
      await deps.bus.publish(requestedEvent);
      return deliver(alert, requestedEvent.event_id);
    },

    async retryDueAlerts() {
      const nowMs = deps.clock.nowMs();
      const timeoutMs = (deps.pendingTimeoutSeconds ?? 120) * 1000;
      let retried = 0;
      for (let alert of await deps.alerts.listAllForSystemTick()) {
        if (alert.status === "SENT" || alert.exhausted) continue;

        // An attempt that was reserved and never completed (a crash mid-send) is closed as an
        // interrupted, retryable failure so the normal retry path takes over.
        const deliveries = await deps.deliveries.listByAlert(alert.organizationId, alert.alertId);
        const stuck = deliveries.filter(
          (d) => d.status === "PENDING" && nowMs - Date.parse(d.requestedAt) > timeoutMs,
        );
        for (const d of stuck) {
          const at = nowIso(deps.clock);
          await deps.deliveries.complete({
            ...d,
            status: "FAILED",
            completedAt: at,
            failure: {
              code: "INTERRUPTED",
              message: "the attempt did not complete",
              retryable: true,
            },
          });
          const attempts = [
            ...alert.attempts,
            {
              notificationId: d.notificationId,
              status: "FAILED" as const,
              channel: d.channel,
              recipientRef: d.recipientRef,
              requestedAt: d.requestedAt,
              completedAt: at,
              failure: { code: "INTERRUPTED", message: "the attempt did not complete" },
            },
          ];
          const exhausted = attempts.length >= alert.maxAttempts;
          alert = {
            ...alert,
            status: "FAILED",
            attempts,
            exhausted,
            ...(!exhausted && { nextRetryAt: at }),
          };
          await deps.alerts.save(alert);
        }
        const pendingLeft = deliveries.some(
          (d) => d.status === "PENDING" && !stuck.some((s) => s.deliveryId === d.deliveryId),
        );
        if (pendingLeft || alert.exhausted) continue;

        const neverStarted =
          alert.status === "REQUESTED" &&
          alert.attempts.length === 0 &&
          deliveries.length === 0 &&
          nowMs - Date.parse(alert.requestedAt) > timeoutMs;
        const retryDue =
          alert.status === "FAILED" &&
          alert.nextRetryAt !== undefined &&
          Date.parse(alert.nextRetryAt) <= nowMs;
        if (neverStarted || retryDue) {
          await deliver(alert, null);
          retried += 1;
        }
      }
      return retried;
    },
  };
}

/**
 * Starts the S4 alerting consumer: `case.created` requests the INITIAL alert for the new case's
 * active risk event. The reason codes come from the detection that opened the case. A recurrence
 * opens a new risk event on the same case; its INITIAL alert is a new alert whose wording says
 * the hazard returned (D-090).
 */
export function startAlerting(deps: AlertingDeps, alerting: Alerting): Unsubscribe {
  const detections = new Map<string, readonly string[]>();
  const latestReasons = new Map<string, readonly string[]>();
  deps.bus.subscribe("risk.detected.v1", (e) => {
    detections.set(e.payload.detectionId, e.payload.reasonCodes);
  });
  deps.bus.subscribe("recurrence.detected.v1", (e) => {
    detections.set(e.payload.detectionId, e.payload.reasonCodes);
    latestReasons.set(e.payload.caseId, e.payload.reasonCodes);
  });
  deps.bus.subscribe("case.reopened.v1", async (event) => {
    const caseRecord = await deps.cases.get(event.organization_id, event.payload.caseId);
    const riskEvent = await deps.riskEvents.get(event.organization_id, event.payload.riskEventId);
    if (caseRecord === undefined || riskEvent === undefined) return;
    await alerting.requestAlert({
      caseRecord,
      event: riskEvent,
      kind: "INITIAL",
      correlationId: event.correlation_id,
      causationId: event.event_id,
      reasonCodes: latestReasons.get(event.payload.caseId) ?? [],
      trigger: {
        type: "RECURRENCE",
        referenceId: riskEvent.eventId,
        why: `The hazard returned after a verified improvement (recurrence ${event.payload.recurrenceCount}); the same case was reopened.`,
      },
    });
  });
  return deps.bus.subscribe("case.created.v1", async (event) => {
    const caseRecord = await deps.cases.get(event.organization_id, event.payload.caseId);
    const riskEvent = await deps.riskEvents.get(event.organization_id, event.payload.riskEventId);
    if (caseRecord === undefined || riskEvent === undefined) return;
    await alerting.requestAlert({
      caseRecord,
      event: riskEvent,
      kind: "INITIAL",
      correlationId: event.correlation_id,
      causationId: event.event_id,
      reasonCodes: detections.get(event.payload.detectionId) ?? [],
    });
  });
}
