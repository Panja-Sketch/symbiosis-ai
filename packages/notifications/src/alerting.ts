import type {
  Alert,
  AlertKind,
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
import type { ActorDirectory } from "@symbiosis/tenancy";
import { composeAlert } from "./compose";
import type { NotificationSender } from "./sender";

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
  readonly policy: EscalationPolicy;
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
  }): Promise<Alert>;
  /** Re-attempts failed, non-exhausted alerts whose retry time has come. */
  retryDueAlerts(): Promise<number>;
};

const laterIso = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Alert lifecycle rule (D-030): the risk event becomes ALERTED only when the configured
 * notification channel returns SENT for the INITIAL alert. Constructing or requesting an alert
 * changes nothing; a FAILED attempt keeps the event DETECTED and records the failure, then
 * retries on a fixed interval up to `maxDeliveryAttempts`. If every attempt fails the alert
 * is exhausted, and the escalation tick escalates the still-DETECTED event to a human.
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

  async function deliver(alert: Alert, causationId: string | null): Promise<Alert> {
    const ctx = {
      org: alert.organizationId,
      fac: alert.facilityId,
      correlationId: alert.correlationId,
    };
    const caseRecord = await deps.cases.get(alert.organizationId, alert.caseId);
    const attemptNo = alert.attempts.length + 1;
    const requestedAt = nowIso(deps.clock);
    const request: NotificationRequest = {
      notificationId: deps.ids.next("NTF"),
      organizationId: alert.organizationId,
      facilityId: alert.facilityId,
      channel: alert.channel,
      recipient: alert.recipient,
      subject: `[${alert.kind === "ESCALATION" ? "ESCALATION" : "ALERT"}] [${alert.severity}] ${caseRecord?.title ?? alert.hazardType}`,
      body: composeBody(alert, caseRecord),
      caseId: alert.caseId,
      riskEventId: alert.riskEventId,
      severity: alert.severity,
      requestedAt,
    };
    const requested = emit(
      "notification.requested.v1",
      {
        notificationId: request.notificationId,
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
        notificationId: request.notificationId,
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
          notificationId: request.notificationId,
          status: "FAILED",
          channel: alert.channel,
          recipientRef: alert.recipient.ref,
          requestedAt,
          completedAt: nowIso(deps.clock),
          failure: { code: "SENDER_ERROR", message: (error as Error).message },
        };
      }
    }

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
        details: { attempt: attemptNo, channel: result.channel, recipient: result.recipientRef },
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

    const exhausted = attempts.length >= alert.maxAttempts;
    const nextRetryAt = exhausted
      ? undefined
      : new Date(
          Date.parse(result.completedAt) + deps.policy.alert.retryIntervalSeconds * 1000,
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

  function composeBody(alert: Alert, caseRecord: RiskImprovementCase | undefined): string {
    if (caseRecord === undefined) return alert.summary;
    return composeAlert({
      caseRecord,
      kind: alert.kind,
      reasonCodes: alert.reasonCodes,
      casePath: `/ui/cases/${alert.caseId}`,
    }).body;
  }

  return {
    async requestAlert(input) {
      const { caseRecord, event, kind } = input;
      const alertId = `ALR-${event.eventId}-${kind}`;
      const existing = await deps.alerts.get(caseRecord.organizationId, alertId);
      if (existing !== undefined) return existing; // duplicate processing: no second alert

      const role =
        kind === "INITIAL"
          ? deps.policy.alert.initialRecipientRole
          : deps.policy.alert.escalationRecipientRole;
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
        channel: deps.policy.alert.channel,
        status: "REQUESTED",
        attempts: [],
        maxAttempts: deps.policy.alert.maxDeliveryAttempts,
        exhausted: false,
        requestedAt: nowIso(deps.clock),
        correlationId: input.correlationId,
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
        details: { kind, recipientRole: role },
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
      let retried = 0;
      for (const alert of await deps.alerts.listAllForSystemTick()) {
        if (
          alert.status === "FAILED" &&
          !alert.exhausted &&
          alert.nextRetryAt !== undefined &&
          Date.parse(alert.nextRetryAt) <= nowMs
        ) {
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
 * active risk event. The reason codes come from the detection that opened the case.
 */
export function startAlerting(deps: AlertingDeps, alerting: Alerting): Unsubscribe {
  const detections = new Map<string, readonly string[]>();
  deps.bus.subscribe("risk.detected.v1", (e) => {
    detections.set(e.payload.detectionId, e.payload.reasonCodes);
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
