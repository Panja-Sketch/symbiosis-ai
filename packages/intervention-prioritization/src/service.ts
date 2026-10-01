import { err, ok } from "@symbiosis/contracts";
import type {
  Result,
  RiskEngineerInterventionRecommendation,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { can } from "@symbiosis/authz";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  CaseRepository,
  InterventionRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import { canAccessFacility } from "@symbiosis/tenancy";
import type { ActorContext } from "@symbiosis/tenancy";
import { buildInterventionFacts, evaluateInterventionPolicy } from "./engine";
import type { InterventionPolicy } from "./policy";

export type InterventionServiceDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly verifications: VerificationRepository;
  readonly interventions: InterventionRepository;
  readonly policy: InterventionPolicy;
};

export type InterventionError = {
  readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT";
  readonly message: string;
};
const fail = (code: InterventionError["code"], message: string) =>
  err<InterventionError>({ code, message });

export type InterventionService = {
  /**
   * Recomputes the recommendation of a case from persisted facts. A changed result supersedes
   * the current recommendation (which stays auditable); an identical one changes nothing. A
   * closed case resolves its current recommendation. Idempotent.
   */
  recalculateForCase(
    organizationId: string,
    caseId: string,
    trigger: { readonly correlationId: string; readonly causationId: string | null },
  ): Promise<RiskEngineerInterventionRecommendation | undefined>;
  list(
    actor: ActorContext,
  ): Promise<Result<readonly RiskEngineerInterventionRecommendation[], InterventionError>>;
  get(
    actor: ActorContext,
    interventionId: string,
  ): Promise<Result<RiskEngineerInterventionRecommendation, InterventionError>>;
  /** Human acknowledgement of a recommendation. It decides, schedules and changes nothing else. */
  acknowledge(
    actor: ActorContext,
    interventionId: string,
  ): Promise<Result<RiskEngineerInterventionRecommendation, InterventionError>>;
};

export function createInterventionService(deps: InterventionServiceDeps): InterventionService {
  const { policy } = deps;

  const publish = async (
    r: RiskEngineerInterventionRecommendation,
    c: RiskImprovementCase,
    trigger: { correlationId: string; causationId: string | null },
    extra: {
      previousLevel?: RiskEngineerInterventionRecommendation["level"];
      supersededId?: string;
    },
  ) =>
    deps.bus.publish(
      createEnvelope(deps.ids, {
        type: "intervention.recommendation_updated.v1",
        correlationId: trigger.correlationId,
        causationId: trigger.causationId,
        organizationId: r.organizationId,
        facilityId: c.facilityId,
        occurredAt: nowIso(deps.clock),
        producer: "worker",
        payload: {
          interventionId: r.interventionId,
          ...(r.caseId !== undefined && { caseId: r.caseId }),
          level: r.level,
          ...(extra.previousLevel !== undefined && { previousLevel: extra.previousLevel }),
          status: r.status,
          policyId: r.policyId,
          policyVersion: r.policyVersion,
          reasonCodes: r.reasonCodes,
          ...(extra.supersededId !== undefined && { supersededInterventionId: extra.supersededId }),
          generatedAt: r.generatedAt,
        },
      }),
    );

  const audit = (
    c: RiskImprovementCase,
    action: "INTERVENTION_RECOMMENDED" | "INTERVENTION_ACKNOWLEDGED" | "INTERVENTION_RESOLVED",
    actorId: string,
    actorType: "USER" | "SYSTEM",
    r: RiskEngineerInterventionRecommendation,
    correlationId: string,
    at: string,
  ) =>
    deps.audit.append({
      organizationId: c.organizationId,
      facilityId: c.facilityId,
      caseId: c.caseId,
      actorId,
      actorType,
      action,
      targetType: "INTERVENTION",
      targetId: r.interventionId,
      afterState: r.status,
      correlationId,
      at,
      details: { level: r.level, reasonCodes: r.reasonCodes },
    });

  async function recalculateForCase(
    organizationId: string,
    caseId: string,
    trigger: { readonly correlationId: string; readonly causationId: string | null },
  ) {
    const c = await deps.cases.get(organizationId, caseId);
    if (c === undefined) return undefined;
    const history = await deps.interventions.listByCase(organizationId, caseId);
    const current = [...history]
      .reverse()
      .find((r) => r.status === "ACTIVE" || r.status === "ACKNOWLEDGED");
    const now = nowIso(deps.clock);

    if (c.state === "CLOSED") {
      if (current === undefined) return undefined;
      const resolved: RiskEngineerInterventionRecommendation = {
        ...current,
        status: "RESOLVED",
        resolvedAt: now,
      };
      await deps.interventions.save(resolved);
      await audit(
        c,
        "INTERVENTION_RESOLVED",
        "SYSTEM-INTERVENTION",
        "SYSTEM",
        resolved,
        trigger.correlationId,
        now,
      );
      await publish(resolved, c, trigger, {});
      return resolved;
    }

    const attempts = await deps.verifications.listByCase(organizationId, caseId);
    const trail = await deps.audit.listByCase(organizationId, caseId);
    const bundle = buildInterventionFacts({ policy, caseRecord: c, attempts, audit: trail });
    const decision = evaluateInterventionPolicy(policy, bundle.facts);

    if (
      current !== undefined &&
      current.level === decision.level &&
      current.policyVersion === policy.policyVersion &&
      current.reasonCodes.join("|") === decision.reasonCodes.join("|")
    ) {
      return current; // nothing material changed
    }

    const fresh: RiskEngineerInterventionRecommendation = {
      interventionId: deps.ids.next("INT"),
      organizationId,
      facilityId: c.facilityId,
      caseId,
      level: decision.level,
      policyId: policy.policyId,
      policyVersion: policy.policyVersion,
      reasonCodes: decision.reasonCodes,
      supportingEvidenceIds: bundle.supportingEvidenceIds,
      dataSufficiency: bundle.dataSufficiency,
      generatedAt: now,
      status: "ACTIVE",
    };
    if (current !== undefined) {
      await deps.interventions.save({
        ...current,
        status: "SUPERSEDED",
        supersededBy: fresh.interventionId,
      });
    }
    await deps.interventions.save(fresh);
    await audit(
      c,
      "INTERVENTION_RECOMMENDED",
      "SYSTEM-INTERVENTION",
      "SYSTEM",
      fresh,
      trigger.correlationId,
      now,
    );
    await publish(fresh, c, trigger, {
      ...(current !== undefined && {
        previousLevel: current.level,
        supersededId: current.interventionId,
      }),
    });
    return fresh;
  }

  async function visible(actor: ActorContext, interventionId: string) {
    const r = await deps.interventions.get(actor.organizationId, interventionId);
    return r !== undefined && canAccessFacility(actor, r.facilityId) ? r : undefined;
  }

  return {
    recalculateForCase,

    async list(actor) {
      if (!can(actor, "INTERVENTION_READ"))
        return fail("FORBIDDEN", "Missing permission INTERVENTION_READ");
      const all = await deps.interventions.list(actor.organizationId);
      return ok(all.filter((r) => canAccessFacility(actor, r.facilityId)));
    },

    async get(actor, interventionId) {
      if (!can(actor, "INTERVENTION_READ"))
        return fail("FORBIDDEN", "Missing permission INTERVENTION_READ");
      const r = await visible(actor, interventionId);
      return r === undefined ? fail("NOT_FOUND", "Intervention not found") : ok(r);
    },

    async acknowledge(actor, interventionId) {
      if (!can(actor, "INTERVENTION_ACKNOWLEDGE")) {
        return fail("FORBIDDEN", "Missing permission INTERVENTION_ACKNOWLEDGE");
      }
      const r = await visible(actor, interventionId);
      if (r === undefined) return fail("NOT_FOUND", "Intervention not found");
      if (r.status !== "ACTIVE")
        return fail("CONFLICT", `Cannot acknowledge a ${r.status} recommendation`);
      const c =
        r.caseId === undefined ? undefined : await deps.cases.get(r.organizationId, r.caseId);
      const now = nowIso(deps.clock);
      const next: RiskEngineerInterventionRecommendation = {
        ...r,
        status: "ACKNOWLEDGED",
        acknowledgedBy: actor.actorId,
        acknowledgedAt: now,
      };
      await deps.interventions.save(next);
      const correlationId = deps.ids.next("CORR");
      if (c !== undefined) {
        await audit(
          c,
          "INTERVENTION_ACKNOWLEDGED",
          actor.actorId,
          "USER",
          next,
          correlationId,
          now,
        );
        await publish(next, c, { correlationId, causationId: null }, {});
      }
      return ok(next);
    },
  };
}

/**
 * Recalculation triggers (spec 23A.6): risk.detected, verification.completed, recurrence.detected,
 * case.reopened, plus case.created / risk.escalated / case closure, which change the same facts.
 * Handlers are idempotent: an unchanged result writes nothing.
 */
export function startInterventions(
  deps: InterventionServiceDeps,
  service: InterventionService,
): Unsubscribe {
  const subs: Unsubscribe[] = [];
  const on = (
    type:
      | "case.created.v1"
      | "verification.completed.v1"
      | "recurrence.detected.v1"
      | "case.reopened.v1"
      | "risk.escalated.v1",
  ) =>
    subs.push(
      deps.bus.subscribe(type, async (e) => {
        await service.recalculateForCase(e.organization_id, e.payload.caseId, {
          correlationId: e.correlation_id,
          causationId: e.event_id,
        });
      }),
    );
  on("case.created.v1");
  on("verification.completed.v1");
  on("recurrence.detected.v1");
  on("case.reopened.v1");
  on("risk.escalated.v1");
  subs.push(
    deps.bus.subscribe("case.updated.v1", async (e) => {
      if (e.payload.change === "CASE_CLOSED" || e.payload.change === "DETECTION_CONTINUED") {
        await service.recalculateForCase(e.organization_id, e.payload.caseId, {
          correlationId: e.correlation_id,
          causationId: e.event_id,
        });
      }
    }),
  );
  subs.push(
    deps.bus.subscribe("risk.detected.v1", async (e) => {
      const d = e.payload;
      const c = await deps.cases.findActive(
        e.organization_id,
        e.facility_id,
        d.hazardType,
        d.primaryAssetId,
      );
      if (c !== undefined) {
        await service.recalculateForCase(e.organization_id, c.caseId, {
          correlationId: e.correlation_id,
          causationId: e.event_id,
        });
      }
    }),
  );
  return () => subs.forEach((u) => u());
}
