import { resolveValue } from "@symbiosis/contracts";
import type {
  AlertTrigger,
  FollowUpTrigger,
  Resolvable,
  RiskEvent,
  RiskImprovementCase,
  VerificationAttempt,
  VerificationResult,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  ActionRepository,
  CaseRepository,
  RiskEventRepository,
  TenantDocumentStore,
  VerificationRepository,
} from "@symbiosis/repositories";
import { ROLES } from "@symbiosis/tenancy";
import type { Role } from "@symbiosis/tenancy";
import { alertIdFor } from "./alerting";
import type { Alerting } from "./alerting";

/**
 * Closed-loop follow-up (S10, D-090). If a person reports an action but the physical condition does
 * not improve, Symbiosis follows up. Whether and when is DETERMINISTIC policy over deterministic
 * facts (a completed verification, an assignment that was never reported): no AI model decides it.
 * Every decision, taken or suppressed, is recorded with its reason. Cooldowns and a per-event cap
 * keep it from spamming people.
 */
export const FOLLOW_UP_POLICY_SCHEMA = "follow-up-policy.v1" as const;

/** `RECURRENCE` is not configurable here: a recurrence always notifies through the INITIAL alert. */
export const CONFIGURABLE_TRIGGERS = [
  "VERIFICATION_NOT_IMPROVING",
  "VERIFICATION_PARTIALLY_VERIFIED",
  "VERIFICATION_INCONCLUSIVE",
  "ACTION_OVERDUE",
] as const satisfies readonly FollowUpTrigger[];
export type ConfigurableTrigger = (typeof CONFIGURABLE_TRIGGERS)[number];

export type TriggerPolicy = {
  readonly enabled: boolean;
  readonly recipientRole: Role;
  /** Minimum seconds between two follow-ups of the same trigger for the same case. */
  readonly cooldownSeconds: number;
};

export type FollowUpPolicy = {
  readonly schema: typeof FOLLOW_UP_POLICY_SCHEMA;
  readonly version: string;
  readonly triggers: Readonly<Record<ConfigurableTrigger, TriggerPolicy>> & {
    readonly ACTION_OVERDUE: TriggerPolicy & { readonly overdueAfterSeconds: number };
  };
  readonly maxFollowUpsPerRiskEvent: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseFollowUpPolicy(value: unknown): FollowUpPolicy {
  const fail = (why: string): never => {
    throw new Error(`invalid follow-up policy: ${why}`);
  };
  if (!isRecord(value)) return fail("not an object");
  if (value.schema !== FOLLOW_UP_POLICY_SCHEMA) fail("schema");
  if (typeof value.version !== "string" || value.version === "") fail("version");
  const max = value.maxFollowUpsPerRiskEvent;
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 50)
    fail("maxFollowUpsPerRiskEvent");
  const t = value.triggers;
  if (!isRecord(t)) return fail("triggers");
  const tr = t as Record<string, unknown>;
  for (const k of Object.keys(tr)) {
    if (!(CONFIGURABLE_TRIGGERS as readonly string[]).includes(k)) fail(`unknown trigger ${k}`);
  }
  const out: Record<string, unknown> = {};
  for (const key of CONFIGURABLE_TRIGGERS) {
    const p = tr[key];
    if (!isRecord(p)) return fail(`trigger ${key} is missing`);
    if (typeof p.enabled !== "boolean") fail(`${key}.enabled`);
    if (!(ROLES as readonly unknown[]).includes(p.recipientRole)) fail(`${key}.recipientRole`);
    if (
      !Number.isFinite(p.cooldownSeconds) ||
      (p.cooldownSeconds as number) < 0 ||
      (p.cooldownSeconds as number) > 86_400
    ) {
      fail(`${key}.cooldownSeconds`);
    }
    out[key] = {
      enabled: p.enabled,
      recipientRole: p.recipientRole,
      cooldownSeconds: p.cooldownSeconds,
      ...(key === "ACTION_OVERDUE" && { overdueAfterSeconds: p.overdueAfterSeconds }),
    };
  }
  const overdue = (out.ACTION_OVERDUE as { overdueAfterSeconds?: unknown }).overdueAfterSeconds;
  if (!Number.isFinite(overdue) || (overdue as number) < 30 || (overdue as number) > 604_800) {
    fail("ACTION_OVERDUE.overdueAfterSeconds");
  }
  return {
    schema: FOLLOW_UP_POLICY_SCHEMA,
    version: value.version as string,
    triggers: out as FollowUpPolicy["triggers"],
    maxFollowUpsPerRiskEvent: max as number,
  };
}

type FollowUpState = {
  readonly caseId: string;
  /** Last time each trigger produced a follow-up (ISO). */
  readonly lastRequestedAt: Readonly<Record<string, string>>;
  /** Follow-ups requested per risk event. */
  readonly countByEvent: Readonly<Record<string, number>>;
  /** `<trigger>:<reference>` already admitted; makes redelivery idempotent. */
  readonly admitted: readonly string[];
};

export type FollowUpDeps = {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly actions: ActionRepository;
  readonly verifications: VerificationRepository;
  readonly alerts: { get(organizationId: string, alertId: string): Promise<unknown> };
  readonly alerting: Alerting;
  readonly store: TenantDocumentStore;
  readonly policy: Resolvable<FollowUpPolicy>;
};

export type FollowUps = {
  onVerificationCompleted(organizationId: string, verificationId: string): Promise<void>;
  /** Scheduler seam: the overdue-action trigger. */
  tick(): Promise<{ readonly requested: number; readonly suppressed: number }>;
};

const TRIGGER_FOR_RESULT: Readonly<Partial<Record<VerificationResult, ConfigurableTrigger>>> = {
  NOT_IMPROVING: "VERIFICATION_NOT_IMPROVING",
  PARTIALLY_VERIFIED: "VERIFICATION_PARTIALLY_VERIFIED",
  INCONCLUSIVE: "VERIFICATION_INCONCLUSIVE",
};

type Decision =
  | { readonly allowed: true; readonly resumed: boolean }
  | { readonly allowed: false; readonly reason: "DISABLED" | "COOLDOWN" | "MAX_FOLLOW_UPS" };

export function createFollowUps(deps: FollowUpDeps): FollowUps {
  const fresh = (caseId: string): FollowUpState => ({
    caseId,
    lastRequestedAt: {},
    countByEvent: {},
    admitted: [],
  });

  /** Atomically decides and, when allowed, records the admission (so concurrent runs agree). */
  async function admit(
    c: RiskImprovementCase,
    event: RiskEvent,
    trigger: ConfigurableTrigger,
    referenceId: string,
    policy: FollowUpPolicy,
  ): Promise<Decision> {
    const tp = policy.triggers[trigger];
    if (!tp.enabled) return { allowed: false, reason: "DISABLED" };
    const nowMs = deps.clock.nowMs();
    const key = `${trigger}:${referenceId}`;
    let decision: Decision = { allowed: false, reason: "COOLDOWN" };
    await deps.store.update<FollowUpState>("followUpState", c.organizationId, c.caseId, (cur) => {
      const s = cur ?? fresh(c.caseId);
      if (s.admitted.includes(key)) {
        decision = { allowed: true, resumed: true };
        return undefined;
      }
      const last = s.lastRequestedAt[trigger];
      if (last !== undefined && nowMs - Date.parse(last) < tp.cooldownSeconds * 1000) {
        decision = { allowed: false, reason: "COOLDOWN" };
        return undefined;
      }
      if ((s.countByEvent[event.eventId] ?? 0) >= policy.maxFollowUpsPerRiskEvent) {
        decision = { allowed: false, reason: "MAX_FOLLOW_UPS" };
        return undefined;
      }
      decision = { allowed: true, resumed: false };
      return {
        doc: {
          ...s,
          lastRequestedAt: { ...s.lastRequestedAt, [trigger]: new Date(nowMs).toISOString() },
          countByEvent: {
            ...s.countByEvent,
            [event.eventId]: (s.countByEvent[event.eventId] ?? 0) + 1,
          },
          admitted: [...s.admitted, key].slice(-200),
        },
      };
    });
    return decision;
  }

  async function request(
    c: RiskImprovementCase,
    event: RiskEvent,
    trigger: ConfigurableTrigger,
    referenceId: string,
    why: string,
    policy: FollowUpPolicy,
    correlationId: string,
  ): Promise<"REQUESTED" | "SUPPRESSED" | "DUPLICATE"> {
    const alertTrigger: AlertTrigger = { type: trigger, referenceId, why };
    // A redelivered event or a repeated tick finds the alert and does nothing more.
    if (
      (await deps.alerts.get(
        c.organizationId,
        alertIdFor(event.eventId, "FOLLOW_UP", alertTrigger),
      )) !== undefined
    ) {
      return "DUPLICATE";
    }
    const decision = await admit(c, event, trigger, referenceId, policy);
    const at = nowIso(deps.clock);
    if (!decision.allowed) {
      await deps.audit.append({
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        caseId: c.caseId,
        actorId: "SYSTEM-FOLLOW-UP",
        actorType: "SYSTEM",
        action: "FOLLOW_UP_SUPPRESSED",
        targetType: "CASE",
        targetId: c.caseId,
        correlationId,
        at,
        details: { trigger, referenceId, reason: decision.reason, policyVersion: policy.version },
      });
      return "SUPPRESSED";
    }
    if (!decision.resumed) {
      await deps.audit.append({
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        caseId: c.caseId,
        actorId: "SYSTEM-FOLLOW-UP",
        actorType: "SYSTEM",
        action: "FOLLOW_UP_REQUESTED",
        targetType: "CASE",
        targetId: c.caseId,
        correlationId,
        at,
        details: {
          trigger,
          referenceId,
          why,
          recipientRole: policy.triggers[trigger].recipientRole,
          policyVersion: policy.version,
        },
      });
    }
    await deps.alerting.requestAlert({
      caseRecord: c,
      event,
      kind: "FOLLOW_UP",
      correlationId,
      causationId: null,
      trigger: alertTrigger,
      recipientRole: policy.triggers[trigger].recipientRole,
    });
    return "REQUESTED";
  }

  const minutes = (s: number) => (s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`);

  function describeVerification(a: VerificationAttempt): string {
    const failed = (a.assessment?.requiredCriteria ?? [])
      .filter(
        (k) =>
          !k.passed && k.criterionId !== "DATA_QUALITY" && k.criterionId !== "DEVICE_INTEGRITY",
      )
      .map((k) => k.criterionId.toLowerCase().replace(/_/g, " "));
    const integrity = (a.assessment?.requiredCriteria ?? [])
      .filter(
        (k) =>
          !k.passed && (k.criterionId === "DATA_QUALITY" || k.criterionId === "DEVICE_INTEGRITY"),
      )
      .map((k) => k.criterionId.toLowerCase().replace(/_/g, " "));
    const parts = [
      failed.length > 0 ? `required criteria not met: ${failed.join(", ")}` : undefined,
      integrity.length > 0 ? `evidence not sufficient: ${integrity.join(", ")}` : undefined,
    ].filter((p): p is string => p !== undefined);
    return parts.length > 0 ? parts.join("; ") : "the verification policy was not satisfied";
  }

  return {
    async onVerificationCompleted(organizationId, verificationId) {
      const attempt = await deps.verifications.get(organizationId, verificationId);
      if (
        attempt === undefined ||
        attempt.status !== "COMPLETED" ||
        attempt.assessment === undefined
      )
        return;
      const trigger = TRIGGER_FOR_RESULT[attempt.assessment.result];
      if (trigger === undefined) return; // VERIFIED: nothing to follow up
      const c = await deps.cases.get(organizationId, attempt.caseId);
      const event = await deps.riskEvents.get(organizationId, attempt.eventId);
      if (c === undefined || event === undefined || c.state === "CLOSED") return;
      const policy = await resolveValue(deps.policy, organizationId, c.facilityId);
      const result = attempt.assessment.result.replace(/_/g, " ").toLowerCase();
      await request(
        c,
        event,
        trigger,
        verificationId,
        `The reported action was checked against trusted sensor data and the result is ${result}: ${describeVerification(attempt)}.`,
        policy,
        attempt.correlationId,
      );
    },

    async tick() {
      let requested = 0;
      let suppressed = 0;
      const nowMs = deps.clock.nowMs();
      for (const c of await deps.cases.listAllForSystemTick()) {
        if (c.state !== "ACTION_REQUIRED" || c.activeRiskEventId === undefined) continue;
        const policy = await resolveValue(deps.policy, c.organizationId, c.facilityId);
        const tp = policy.triggers.ACTION_OVERDUE;
        if (!tp.enabled) continue;
        const event = await deps.riskEvents.get(c.organizationId, c.activeRiskEventId);
        if (event === undefined) continue;
        for (const a of await deps.actions.listByCase(c.organizationId, c.caseId)) {
          if (a.eventId !== event.eventId || a.status === "REPORTED_COMPLETE") continue;
          if (a.assignedAt === undefined) continue;
          if (nowMs - Date.parse(a.assignedAt) < tp.overdueAfterSeconds * 1000) continue;
          const r = await request(
            c,
            event,
            "ACTION_OVERDUE",
            a.actionId,
            `The action ${a.actionLibraryId} assigned at ${a.assignedAt} has not been reported complete after ${minutes(tp.overdueAfterSeconds)}.`,
            policy,
            deps.ids.next("CORR"),
          );
          if (r === "REQUESTED") requested += 1;
          else if (r === "SUPPRESSED") suppressed += 1;
        }
      }
      return { requested, suppressed };
    },
  };
}

/** Starts the consumer: `verification.completed` -> follow-up decision. */
export function startFollowUps(
  deps: { readonly bus: EventBus },
  followUps: FollowUps,
): Unsubscribe {
  return deps.bus.subscribe("verification.completed.v1", (event) =>
    followUps.onVerificationCompleted(event.organization_id, event.payload.verificationId),
  );
}
