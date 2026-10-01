import { CONSENT_SCOPES, err, isIsoTimestamp, ok } from "@symbiosis/contracts";
import type {
  AgreementStatus,
  ConsentScope,
  EvidencePackageCreatedEvent,
  Result,
  RiskImprovementCase,
  SharingAgreement,
  SharingState,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { can } from "@symbiosis/authz";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  CaseRepository,
  EvidencePackageRepository,
  SharedEvidenceRepository,
  SharingAgreementRepository,
} from "@symbiosis/repositories";
import { applyCaseDocumentation } from "@symbiosis/risk-cases";
import { canAccessFacility } from "@symbiosis/tenancy";
import type { ActorContext, OrganizationDirectory } from "@symbiosis/tenancy";
import {
  EVIDENCE_PACKAGE_SCOPES,
  agreementStatus,
  deriveSharingState,
  isConsentScope,
} from "./access";

export type ConsentErrorCode = "NOT_FOUND" | "FORBIDDEN" | "INVALID_REQUEST" | "CONFLICT";
export type ConsentError = {
  readonly code: ConsentErrorCode;
  readonly message: string;
  readonly details?: readonly string[];
};
const fail = (code: ConsentErrorCode, message: string, details?: readonly string[]) =>
  err<ConsentError>({ code, message, ...(details !== undefined && { details }) });

export type CreateAgreementInput = {
  readonly recipientOrganizationId?: unknown;
  readonly scopes?: unknown;
  readonly facilityIds?: unknown;
  readonly effectiveFrom?: unknown;
  readonly expiresAt?: unknown;
};

export type AgreementView = {
  readonly agreement: SharingAgreement;
  readonly status: AgreementStatus;
  /** Cases whose latest package this agreement released. */
  readonly sharedCaseIds: readonly string[];
};

export type SharingService = {
  createAgreement(
    actor: ActorContext,
    input: CreateAgreementInput,
  ): Promise<Result<AgreementView, ConsentError>>;
  revokeAgreement(
    actor: ActorContext,
    agreementId: string,
    reason?: unknown,
  ): Promise<Result<AgreementView, ConsentError>>;
  listAgreements(actor: ActorContext): Promise<Result<readonly AgreementView[], ConsentError>>;
  getAgreement(
    actor: ActorContext,
    agreementId: string,
  ): Promise<Result<AgreementView, ConsentError>>;
  /** Agreements of the actor's organization that cover the case's facility. */
  listForCase(
    actor: ActorContext,
    caseId: string,
  ): Promise<Result<readonly AgreementView[], ConsentError>>;
  /** Recomputes sharing state (also catches expiry). Scheduler seam. */
  reconcileAll(): Promise<{ readonly changed: readonly string[] }>;
};

export type SharingDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly agreements: SharingAgreementRepository;
  readonly shares: SharedEvidenceRepository;
  readonly packages: EvidencePackageRepository;
  readonly organizations: OrganizationDirectory;
};

const SCOPE_ORDER = (s: ConsentScope) => CONSENT_SCOPES.indexOf(s);
const RECIPIENT_TYPES = ["INSURER", "BROKER"];

export function createSharingService(deps: SharingDeps): SharingService & {
  /** Worker seam: reacts to a freshly created package. */
  onPackageCreated(event: EvidencePackageCreatedEvent): Promise<void>;
} {
  const viewOf = async (a: SharingAgreement): Promise<AgreementView> => ({
    agreement: a,
    status: agreementStatus(a, deps.clock.nowMs()),
    sharedCaseIds: [
      ...new Set(
        (await deps.shares.listByAgreement(a.organizationId, a.agreementId)).map((s) => s.caseId),
      ),
    ],
  });

  /**
   * Derives and persists the case's sharing state, and records which active agreements now
   * release its latest package (one ledger row and one `evidence.shared.v1` each, once).
   */
  async function reconcileCase(
    c: RiskImprovementCase,
    context: {
      readonly correlationId: string;
      readonly causationId: string | null;
      readonly producer: "api" | "worker";
      readonly reason: string;
    },
  ): Promise<{ readonly previous: SharingState; readonly state: SharingState }> {
    const previous = c.sharingState;
    const packageId = c.latestEvidencePackageId;
    if (packageId === undefined) return { previous, state: previous };
    const nowMs = deps.clock.nowMs();
    const at = nowIso(deps.clock);

    const mine = await deps.agreements.listForOwner(c.organizationId);
    const releasing = mine.filter(
      (a) =>
        agreementStatus(a, nowMs) === "ACTIVE" &&
        a.facilityIds.includes(c.facilityId) &&
        a.scopes.some((s) => EVIDENCE_PACKAGE_SCOPES.includes(s)),
    );
    for (const a of releasing) {
      const shareId = deps.ids.next("SHR");
      const inserted = await deps.shares.insertIfAbsent({
        shareId,
        agreementId: a.agreementId,
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        caseId: c.caseId,
        evidencePackageId: packageId,
        recipientOrganizationId: a.recipientOrganizationId,
        sharedAt: at,
      });
      if (!inserted) continue;
      await deps.audit.append({
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        caseId: c.caseId,
        actorId: "SYSTEM-CONSENT",
        actorType: "SYSTEM",
        action: "EVIDENCE_SHARED",
        targetType: "EVIDENCE_PACKAGE",
        targetId: packageId,
        correlationId: context.correlationId,
        at,
        details: {
          shareId,
          agreementId: a.agreementId,
          recipientOrganizationId: a.recipientOrganizationId,
          scopes: [...a.scopes],
        },
      });
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          type: "evidence.shared.v1",
          correlationId: context.correlationId,
          causationId: context.causationId,
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          occurredAt: at,
          producer: context.producer,
          payload: {
            shareId,
            agreementId: a.agreementId,
            caseId: c.caseId,
            evidencePackageId: packageId,
            recipientOrganizationId: a.recipientOrganizationId,
            scopes: [...a.scopes],
            sharedAt: at,
          },
        }),
      );
    }

    const everShared = (await deps.shares.listByCase(c.organizationId, c.caseId)).length > 0;
    const state = deriveSharingState({
      hasPackage: true,
      activeAgreementReleasesPackage: releasing.length > 0,
      everShared,
    });
    if (state !== previous) {
      const set = applyCaseDocumentation(c, { type: "SET_SHARING_STATE", sharingState: state });
      if (!set.ok) throw new Error(`sharing state rejected: ${set.error.message}`);
      await deps.cases.save(set.value);
      await deps.audit.append({
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        caseId: c.caseId,
        actorId: "SYSTEM-CONSENT",
        actorType: "SYSTEM",
        action: "SHARING_STATE_CHANGED",
        targetType: "CASE",
        targetId: c.caseId,
        beforeState: previous,
        afterState: state,
        correlationId: context.correlationId,
        at,
        details: { reason: context.reason, evidencePackageId: packageId },
      });
    }
    return { previous, state };
  }

  async function reconcileFacilities(
    organizationId: string,
    facilityIds: readonly string[],
    context: Parameters<typeof reconcileCase>[1],
  ): Promise<void> {
    for (const c of await deps.cases.list(organizationId)) {
      if (!facilityIds.includes(c.facilityId)) continue;
      await reconcileCase(c, context);
    }
  }

  const requireManage = (actor: ActorContext): ConsentError | undefined =>
    can(actor, "SHARING_MANAGE")
      ? undefined
      : { code: "FORBIDDEN", message: "Missing permission SHARING_MANAGE" };

  return {
    async createAgreement(actor, input) {
      const denied = requireManage(actor);
      if (denied !== undefined) return err(denied);
      const issues: string[] = [];

      // recipient: a known, different, insurer-side organization
      const recipientId = input.recipientOrganizationId;
      let recipientOk = false;
      if (typeof recipientId !== "string" || recipientId.length === 0) {
        issues.push("RECIPIENT_REQUIRED");
      } else if (recipientId === actor.organizationId) {
        issues.push("RECIPIENT_MUST_DIFFER_FROM_GRANTOR");
      } else {
        const recipient = await deps.organizations.get(recipientId);
        if (recipient === undefined || !RECIPIENT_TYPES.includes(recipient.type)) {
          issues.push("RECIPIENT_UNKNOWN_OR_NOT_ELIGIBLE");
        } else recipientOk = true;
      }

      // scopes: known, non-empty; raw telemetry needs its own permission
      const scopes: ConsentScope[] = [];
      if (!Array.isArray(input.scopes) || input.scopes.length === 0) {
        issues.push("SCOPES_REQUIRED");
      } else {
        for (const s of input.scopes as unknown[]) {
          if (!isConsentScope(s)) issues.push(`UNKNOWN_SCOPE:${String(s)}`);
          else if (!scopes.includes(s)) scopes.push(s);
        }
      }
      if (scopes.includes("RAW_TELEMETRY") && !can(actor, "SHARING_GRANT_RAW_TELEMETRY")) {
        return fail(
          "FORBIDDEN",
          "Granting RAW_TELEMETRY needs permission SHARING_GRANT_RAW_TELEMETRY",
        );
      }

      // facilities: must belong to the granting organization and be reachable by the actor
      const facilityIds: string[] = [];
      if (!Array.isArray(input.facilityIds) || input.facilityIds.length === 0) {
        issues.push("FACILITIES_REQUIRED");
      } else {
        const org = await deps.organizations.get(actor.organizationId);
        for (const f of input.facilityIds as unknown[]) {
          if (typeof f !== "string" || f.length === 0) issues.push("FACILITY_INVALID");
          else if (org === undefined || !org.facilityIds.includes(f)) {
            issues.push(`FACILITY_NOT_IN_ORGANIZATION:${f}`);
          } else if (!canAccessFacility(actor, f)) {
            return fail("FORBIDDEN", `No access to facility ${f}`);
          } else if (!facilityIds.includes(f)) facilityIds.push(f);
        }
      }

      // time window
      const nowMs = deps.clock.nowMs();
      const from = input.effectiveFrom === undefined ? nowIso(deps.clock) : input.effectiveFrom;
      let effectiveFrom = "";
      if (!isIsoTimestamp(from)) issues.push("EFFECTIVE_FROM_INVALID");
      else effectiveFrom = new Date(Date.parse(from)).toISOString();
      let expiresAt: string | undefined;
      if (input.expiresAt !== undefined) {
        if (!isIsoTimestamp(input.expiresAt)) issues.push("EXPIRES_AT_INVALID");
        else {
          expiresAt = new Date(Date.parse(input.expiresAt)).toISOString();
          if (effectiveFrom !== "" && Date.parse(expiresAt) <= Date.parse(effectiveFrom)) {
            issues.push("EXPIRES_AT_NOT_AFTER_EFFECTIVE_FROM");
          } else if (Date.parse(expiresAt) <= nowMs) {
            issues.push("EXPIRES_AT_IN_THE_PAST");
          }
        }
      }
      if (issues.length > 0 || !recipientOk) {
        return fail("INVALID_REQUEST", "Invalid sharing agreement", issues);
      }

      const at = nowIso(deps.clock);
      const agreement: SharingAgreement = {
        agreementId: deps.ids.next("AGR"),
        organizationId: actor.organizationId, // never taken from the request
        recipientOrganizationId: recipientId as string,
        scopes: scopes.sort((a, b) => SCOPE_ORDER(a) - SCOPE_ORDER(b)),
        facilityIds: facilityIds.sort(),
        effectiveFrom,
        ...(expiresAt !== undefined && { expiresAt }),
        createdBy: actor.actorId,
        createdAt: at,
      };
      await deps.agreements.insert(agreement);
      const correlationId = deps.ids.next("CORR");
      await deps.audit.append({
        organizationId: actor.organizationId,
        facilityId: agreement.facilityIds[0] as string,
        actorId: actor.actorId,
        actorType: "USER",
        action: "SHARING_AGREEMENT_CREATED",
        targetType: "SHARING_AGREEMENT",
        targetId: agreement.agreementId,
        correlationId,
        at,
        details: {
          recipientOrganizationId: agreement.recipientOrganizationId,
          scopes: [...agreement.scopes],
          facilityIds: [...agreement.facilityIds],
          effectiveFrom: agreement.effectiveFrom,
          ...(agreement.expiresAt !== undefined && { expiresAt: agreement.expiresAt }),
          includesRawTelemetry: agreement.scopes.includes("RAW_TELEMETRY"),
        },
      });
      const granted = createEnvelope(deps.ids, {
        type: "consent.granted.v1",
        correlationId,
        causationId: null,
        organizationId: actor.organizationId,
        facilityId: agreement.facilityIds[0] as string,
        occurredAt: at,
        producer: "api",
        payload: {
          agreementId: agreement.agreementId,
          recipientOrganizationId: agreement.recipientOrganizationId,
          scopes: agreement.scopes,
          facilityIds: agreement.facilityIds,
          effectiveFrom: agreement.effectiveFrom,
          ...(agreement.expiresAt !== undefined && { expiresAt: agreement.expiresAt }),
          createdBy: agreement.createdBy,
          includesRawTelemetry: agreement.scopes.includes("RAW_TELEMETRY"),
        },
      });
      await deps.bus.publish(granted);
      await reconcileFacilities(actor.organizationId, agreement.facilityIds, {
        correlationId,
        causationId: granted.event_id,
        producer: "api",
        reason: "CONSENT_GRANTED",
      });
      return ok(await viewOf(agreement));
    },

    async revokeAgreement(actor, agreementId, reason) {
      const denied = requireManage(actor);
      if (denied !== undefined) return err(denied);
      if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
        return fail("INVALID_REQUEST", "reason must be a string of at most 500 characters");
      }
      const current = await deps.agreements.getForOwner(actor.organizationId, agreementId);
      if (current === undefined || !current.facilityIds.some((f) => canAccessFacility(actor, f))) {
        return fail("NOT_FOUND", "Sharing agreement not found");
      }
      const at = nowIso(deps.clock);
      const result = await deps.agreements.revoke(actor.organizationId, agreementId, {
        revokedAt: at,
        revokedBy: actor.actorId,
        ...(reason !== undefined && { reason }),
      });
      if (result.status === "NOT_FOUND") return fail("NOT_FOUND", "Sharing agreement not found");
      if (result.status === "ALREADY_REVOKED") {
        return fail("CONFLICT", "The sharing agreement is already revoked");
      }
      const a = result.agreement;
      const correlationId = deps.ids.next("CORR");
      await deps.audit.append({
        organizationId: actor.organizationId,
        facilityId: a.facilityIds[0] as string,
        actorId: actor.actorId,
        actorType: "USER",
        action: "SHARING_AGREEMENT_REVOKED",
        targetType: "SHARING_AGREEMENT",
        targetId: a.agreementId,
        beforeState: "ACTIVE",
        afterState: "REVOKED",
        correlationId,
        at,
        details: {
          recipientOrganizationId: a.recipientOrganizationId,
          ...(reason !== undefined && { reason }),
        },
      });
      const revoked = createEnvelope(deps.ids, {
        type: "consent.revoked.v1",
        correlationId,
        causationId: null,
        organizationId: actor.organizationId,
        facilityId: a.facilityIds[0] as string,
        occurredAt: at,
        producer: "api",
        payload: {
          agreementId: a.agreementId,
          recipientOrganizationId: a.recipientOrganizationId,
          facilityIds: a.facilityIds,
          revokedAt: at,
          revokedBy: actor.actorId,
          ...(reason !== undefined && { reason }),
        },
      });
      await deps.bus.publish(revoked);
      await reconcileFacilities(actor.organizationId, a.facilityIds, {
        correlationId,
        causationId: revoked.event_id,
        producer: "api",
        reason: "CONSENT_REVOKED",
      });
      return ok(await viewOf(a));
    },

    async listAgreements(actor) {
      if (!can(actor, "SHARING_MANAGE") && !can(actor, "EVIDENCE_READ")) {
        return fail("FORBIDDEN", "Missing permission SHARING_MANAGE or EVIDENCE_READ");
      }
      const all = await deps.agreements.listForOwner(actor.organizationId);
      return ok(
        await Promise.all(
          all.filter((a) => a.facilityIds.some((f) => canAccessFacility(actor, f))).map(viewOf),
        ),
      );
    },

    async getAgreement(actor, agreementId) {
      if (!can(actor, "SHARING_MANAGE") && !can(actor, "EVIDENCE_READ")) {
        return fail("FORBIDDEN", "Missing permission SHARING_MANAGE or EVIDENCE_READ");
      }
      const a = await deps.agreements.getForOwner(actor.organizationId, agreementId);
      if (a === undefined || !a.facilityIds.some((f) => canAccessFacility(actor, f))) {
        return fail("NOT_FOUND", "Sharing agreement not found");
      }
      return ok(await viewOf(a));
    },

    async listForCase(actor, caseId) {
      if (!can(actor, "SHARING_MANAGE") && !can(actor, "EVIDENCE_READ")) {
        return fail("FORBIDDEN", "Missing permission SHARING_MANAGE or EVIDENCE_READ");
      }
      const c = await deps.cases.get(actor.organizationId, caseId);
      if (c === undefined || !canAccessFacility(actor, c.facilityId)) {
        return fail("NOT_FOUND", "Case not found");
      }
      const all = await deps.agreements.listForOwner(actor.organizationId);
      return ok(
        await Promise.all(all.filter((a) => a.facilityIds.includes(c.facilityId)).map(viewOf)),
      );
    },

    async reconcileAll() {
      const changed: string[] = [];
      const orgs = new Set(
        (await deps.agreements.listAllForSystemTick()).map((a) => a.organizationId),
      );
      for (const org of orgs) {
        for (const c of await deps.cases.list(org)) {
          if (c.latestEvidencePackageId === undefined) continue;
          const r = await reconcileCase(c, {
            correlationId: deps.ids.next("CORR"),
            causationId: null,
            producer: "worker",
            reason: "SCHEDULED_RECONCILIATION",
          });
          if (r.previous !== r.state) changed.push(c.caseId);
        }
      }
      return { changed };
    },

    async onPackageCreated(event) {
      const c = await deps.cases.get(event.organization_id, event.payload.caseId);
      if (c === undefined) throw new Error(`case ${event.payload.caseId} not found for sharing`);
      const record = await deps.packages.get(
        event.organization_id,
        event.payload.evidencePackageId,
      );
      if (record === undefined) throw new Error("evidence package record not found for sharing");
      const at = nowIso(deps.clock);
      // 1. a package exists: the case becomes SHAREABLE (never SHARED by this fact alone)
      const previous = c.sharingState;
      let current = c;
      if (previous === "NOT_SHARED") {
        const set = applyCaseDocumentation(c, {
          type: "SET_SHARING_STATE",
          sharingState: "SHAREABLE",
        });
        if (!set.ok) throw new Error(`sharing state rejected: ${set.error.message}`);
        await deps.cases.save(set.value);
        current = set.value;
        await deps.audit.append({
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          caseId: c.caseId,
          actorId: "SYSTEM-CONSENT",
          actorType: "SYSTEM",
          action: "SHARING_STATE_CHANGED",
          targetType: "CASE",
          targetId: c.caseId,
          beforeState: previous,
          afterState: "SHAREABLE",
          correlationId: event.correlation_id,
          at,
          details: { reason: "EVIDENCE_PACKAGE_CREATED", evidencePackageId: record.packageId },
        });
      }
      const shareable = createEnvelope(deps.ids, {
        type: "evidence.shareable.v1",
        correlationId: event.correlation_id,
        causationId: event.event_id,
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        occurredAt: at,
        producer: "worker",
        payload: {
          evidencePackageId: record.packageId,
          caseId: c.caseId,
          result: record.result,
          previousSharingState: previous,
          sharingState: current.sharingState,
        },
      });
      await deps.bus.publish(shareable);
      // 2. active agreements that already cover this facility apply to the new package, but only
      //    through the same per-read authorization; this just records the release.
      await reconcileCase(current, {
        correlationId: event.correlation_id,
        causationId: shareable.event_id,
        producer: "worker",
        reason: "EVIDENCE_PACKAGE_CREATED",
      });
    },
  };
}

/** Worker wiring: a new package becomes shareable and may be released under active agreements. */
export function startSharing(
  deps: { readonly bus: EventBus },
  service: ReturnType<typeof createSharingService>,
): Unsubscribe {
  return deps.bus.subscribe("evidence.package_created.v1", (event) =>
    service.onPackageCreated(event),
  );
}
