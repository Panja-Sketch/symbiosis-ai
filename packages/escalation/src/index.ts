import { CASE_SEVERITIES, NOTIFICATION_CHANNELS } from "@symbiosis/contracts";
import type {
  CaseSeverity,
  NotificationChannel,
  RiskEvent,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";
import type { AlertRepository, CaseRepository, RiskEventRepository } from "@symbiosis/repositories";
import { applyRiskEventCommand } from "@symbiosis/risk-lifecycle";
import { ROLES } from "@symbiosis/tenancy";
import type { Role } from "@symbiosis/tenancy";

export const PACKAGE_NAME = "@symbiosis/escalation" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Versioned policy (config/escalation/escalation.v1.json). No timeouts live in code. */
export type EscalationPolicy = {
  readonly version: string;
  readonly alert: {
    readonly channel: NotificationChannel;
    readonly initialRecipientRole: Role;
    readonly escalationRecipientRole: Role;
    readonly maxDeliveryAttempts: number;
    readonly retryIntervalSeconds: number;
  };
  readonly acknowledgementDeadlineSeconds: Readonly<Record<CaseSeverity, number>>;
};

export function parseEscalationPolicy(value: unknown): EscalationPolicy {
  const v = value as EscalationPolicy | null;
  const role = (r: unknown) => (ROLES as readonly unknown[]).includes(r);
  const positive = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0;
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.version !== "string" ||
    !v.alert ||
    !(NOTIFICATION_CHANNELS as readonly unknown[]).includes(v.alert.channel) ||
    !role(v.alert.initialRecipientRole) ||
    !role(v.alert.escalationRecipientRole) ||
    !(Number.isInteger(v.alert.maxDeliveryAttempts) && v.alert.maxDeliveryAttempts >= 1) ||
    !positive(v.alert.retryIntervalSeconds) ||
    !v.acknowledgementDeadlineSeconds ||
    !CASE_SEVERITIES.every((s) => positive(v.acknowledgementDeadlineSeconds[s]))
  ) {
    throw new Error("invalid escalation policy");
  }
  return v;
}

export function acknowledgementDeadlineSeconds(
  policy: EscalationPolicy,
  severity: CaseSeverity,
): number {
  return policy.acknowledgementDeadlineSeconds[severity];
}

/** Asks the alerting capability to notify the escalation recipient (injected: no cycle). */
export type EscalationAlertRequester = (input: {
  readonly caseRecord: RiskImprovementCase;
  readonly event: RiskEvent;
  readonly correlationId: string;
}) => Promise<void>;

export type EscalationDeps = {
  readonly alerts: AlertRepository;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly audit: AuditLog;
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly policy: EscalationPolicy;
  readonly requestEscalationAlert: EscalationAlertRequester;
};

export type EscalationTickResult = {
  readonly escalated: readonly { readonly riskEventId: string; readonly caseId: string }[];
};

/**
 * Deterministic escalation evaluator. It is a plain function over repositories and a Clock, so
 * the local runtime, tests and a future Cloud Scheduler tick all call the same code. A risk
 * event is escalated when:
 *  - its initial alert was SENT, the event is still ALERTED (never acknowledged) and the
 *    severity's acknowledgement deadline has passed; or
 *  - its initial alert is exhausted (every delivery attempt failed) while the event is still
 *    DETECTED, so nobody was ever told.
 * An acknowledged (or later) event is never escalated. Escalation changes operational urgency
 * only; it never changes the physical severity. The original alert is untouched and the
 * escalation notification is a separate alert.
 */
export async function runEscalationTick(deps: EscalationDeps): Promise<EscalationTickResult> {
  const nowMs = deps.clock.nowMs();
  const escalated: { riskEventId: string; caseId: string }[] = [];

  for (const alert of await deps.alerts.listAllForSystemTick()) {
    if (alert.kind !== "INITIAL") continue;
    const event = await deps.riskEvents.get(alert.organizationId, alert.riskEventId);
    const caseRecord = await deps.cases.get(alert.organizationId, alert.caseId);
    if (event === undefined || caseRecord === undefined) continue;

    const deadline = acknowledgementDeadlineSeconds(deps.policy, caseRecord.severity);
    let reason: "ACKNOWLEDGEMENT_OVERDUE" | "ALERT_DELIVERY_EXHAUSTED" | undefined;
    if (
      alert.status === "SENT" &&
      event.state === "ALERTED" &&
      alert.sentAt !== undefined &&
      nowMs >= Date.parse(alert.sentAt) + deadline * 1000
    ) {
      reason = "ACKNOWLEDGEMENT_OVERDUE";
    } else if (alert.exhausted && event.state === "DETECTED") {
      reason = "ALERT_DELIVERY_EXHAUSTED";
    }
    if (reason === undefined) continue;

    const previousState = event.state as "ALERTED" | "DETECTED";
    const at = new Date(Math.max(nowMs, Date.parse(event.updatedAt))).toISOString();
    const transition = applyRiskEventCommand(event, { type: "ESCALATE", at });
    if (!transition.ok) continue;

    await deps.riskEvents.save(transition.value.value);
    await deps.audit.append({
      organizationId: alert.organizationId,
      facilityId: alert.facilityId,
      caseId: alert.caseId,
      actorId: "SYSTEM-ESCALATION",
      actorType: "SYSTEM",
      action: "RISK_ESCALATED",
      targetType: "RISK_EVENT",
      targetId: event.eventId,
      beforeState: previousState,
      afterState: "ESCALATED",
      correlationId: alert.correlationId,
      at,
      details: { reason, acknowledgementDeadlineSeconds: deadline },
    });
    await deps.bus.publish(
      createEnvelope(deps.ids, {
        type: "risk.escalated.v1",
        correlationId: alert.correlationId,
        causationId: null,
        organizationId: alert.organizationId,
        facilityId: alert.facilityId,
        occurredAt: nowIso(deps.clock),
        producer: "worker",
        payload: {
          caseId: alert.caseId,
          riskEventId: event.eventId,
          escalatedAt: at,
          reason,
          acknowledgementDeadlineSeconds: deadline,
          previousState,
        },
      }),
    );
    await deps.requestEscalationAlert({
      caseRecord,
      event: transition.value.value,
      correlationId: alert.correlationId,
    });
    escalated.push({ riskEventId: event.eventId, caseId: alert.caseId });
  }
  return { escalated };
}
