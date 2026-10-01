import { err, ok } from "@symbiosis/contracts";
import type {
  ConsentScope,
  EvidencePackage,
  Result,
  RiskImprovementCase,
  SharingAgreement,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { can } from "@symbiosis/authz";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { EvidenceService } from "@symbiosis/evidence";
import type { IdGenerator } from "@symbiosis/event-bus";
import type {
  CaseRepository,
  EvidencePackageRepository,
  InterventionRepository,
  SharingAgreementRepository,
} from "@symbiosis/repositories";
import type { ActorContext } from "@symbiosis/tenancy";
import { EVIDENCE_PACKAGE_SCOPES, agreementStatus, evaluateAccess } from "./access";
import type { AccessDecision, DenialReason } from "./access";
import { projectCase, projectIntervention, projectRawTelemetry } from "./projection";
import type { InsurerCaseView, InsurerEvidenceView, InsurerInterventionView } from "./projection";

export type InsuranceErrorCode =
  "FORBIDDEN" | "ACCESS_DENIED" | "NOT_FOUND" | "INTEGRITY_FAILURE" | "AUDIT_FAILURE";

/** `reason` is only set for ACCESS_DENIED and never reveals whether an unrelated target exists. */
export type InsuranceError = {
  readonly code: InsuranceErrorCode;
  readonly message: string;
  readonly reason?: DenialReason | "EVIDENCE_INTEGRITY_FAILURE";
};

const fail = (e: InsuranceError) => err<InsuranceError>(e);

export type InsuranceSiteView = {
  readonly siteId: string;
  readonly insuredOrganizationId: string;
  readonly agreements: readonly {
    readonly agreementId: string;
    readonly scopes: readonly ConsentScope[];
    readonly effectiveFrom: string;
    readonly expiresAt?: string;
  }[];
};

export type InsuranceGatewayDeps = {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly agreements: SharingAgreementRepository;
  readonly packages: EvidencePackageRepository;
  readonly interventions: InterventionRepository;
  readonly evidence: EvidenceService;
};

export type InsuranceGateway = {
  sites(actor: ActorContext): Promise<Result<readonly InsuranceSiteView[], InsuranceError>>;
  casesForSite(
    actor: ActorContext,
    siteId: string,
  ): Promise<Result<readonly InsurerCaseView[], InsuranceError>>;
  caseView(actor: ActorContext, caseId: string): Promise<Result<InsurerCaseView, InsuranceError>>;
  /** `includeRawTelemetry` must be asked for explicitly and needs the RAW_TELEMETRY scope. */
  evidence(
    actor: ActorContext,
    caseId: string,
    options?: { readonly packageId?: string; readonly includeRawTelemetry?: boolean },
  ): Promise<Result<InsurerEvidenceView, InsuranceError>>;
  recommendations(actor: ActorContext): Promise<Result<readonly InsurerCaseView[], InsuranceError>>;
  interventions(
    actor: ActorContext,
  ): Promise<Result<readonly InsurerInterventionView[], InsuranceError>>;
};

const ANY_SCOPE_FOR_LISTING: readonly ConsentScope[] = [
  "RECOMMENDATION",
  "INTERVENTION_RECOMMENDATION",
  ...EVIDENCE_PACKAGE_SCOPES,
];

/**
 * The insurer-side read path. EVERY read re-evaluates consent from the stored agreements at the
 * current time, using the recipient organization of the authenticated actor (never a request
 * value), and is audited. The order is: authorize -> load and verify -> project -> audit ->
 * release. A failure anywhere, including the audit write, releases nothing: no failure becomes an
 * authorization success.
 */
export function createInsuranceGateway(deps: InsuranceGatewayDeps): InsuranceGateway {
  const requireRole = (actor: ActorContext): InsuranceError | undefined =>
    can(actor, "INSURANCE_EVIDENCE_READ")
      ? undefined
      : { code: "FORBIDDEN", message: "Missing permission INSURANCE_EVIDENCE_READ" };

  const myAgreements = (actor: ActorContext): Promise<readonly SharingAgreement[]> =>
    deps.agreements.listForRecipient(actor.organizationId); // recipient comes from the actor

  async function auditEntry(
    actor: ActorContext,
    owner: {
      readonly organizationId: string;
      readonly facilityId: string;
      readonly caseId?: string;
    },
    action: "INSURER_EVIDENCE_READ" | "INSURER_ACCESS_DENIED",
    target: {
      readonly type: "CASE" | "SHARING_AGREEMENT" | "EVIDENCE_PACKAGE";
      readonly id: string;
    },
    details: Record<string, string | number | boolean | readonly string[]>,
  ): Promise<void> {
    await deps.audit.append({
      organizationId: owner.organizationId,
      facilityId: owner.facilityId,
      ...(owner.caseId !== undefined && { caseId: owner.caseId }),
      actorId: actor.actorId,
      actorType: "USER",
      action,
      targetType: target.type,
      targetId: target.id,
      correlationId: deps.ids.next("CORR"),
      at: nowIso(deps.clock),
      details: { actorOrganizationId: actor.organizationId, ...details },
    });
  }

  /** Records a denial; if even that cannot be written the answer is still a denial. */
  async function deny(
    actor: ActorContext,
    owner: {
      readonly organizationId: string;
      readonly facilityId: string;
      readonly caseId?: string;
    },
    target: {
      readonly type: "CASE" | "SHARING_AGREEMENT" | "EVIDENCE_PACKAGE";
      readonly id: string;
    },
    reason: DenialReason | "EVIDENCE_INTEGRITY_FAILURE",
    internal: string,
    endpoint: string,
  ): Promise<InsuranceError> {
    try {
      await auditEntry(actor, owner, "INSURER_ACCESS_DENIED", target, {
        endpoint,
        reason,
        internalReason: internal,
      });
    } catch {
      /* the denial stands whether or not it could be audited */
    }
    return reason === "EVIDENCE_INTEGRITY_FAILURE"
      ? {
          code: "INTEGRITY_FAILURE",
          message: "The evidence package failed integrity verification and is withheld",
          reason,
        }
      : { code: "ACCESS_DENIED", message: "Access to this evidence is not granted", reason };
  }

  /** Finds the owner organization and case among the recipient's own agreements only. */
  async function locateCase(
    agreements: readonly SharingAgreement[],
    caseId: string,
  ): Promise<RiskImprovementCase | undefined> {
    for (const owner of new Set(agreements.map((a) => a.organizationId))) {
      const c = await deps.cases.get(owner, caseId);
      if (c !== undefined) return c;
    }
    return undefined;
  }

  async function loadVerifiedPackage(
    c: RiskImprovementCase,
    packageId?: string,
  ): Promise<
    | { readonly ok: true; readonly pkg?: EvidencePackage }
    | { readonly ok: false; readonly missing: boolean }
  > {
    const id = packageId ?? c.latestEvidencePackageId;
    if (id === undefined)
      return packageId === undefined ? { ok: true } : { ok: false, missing: true };
    const record = await deps.packages.get(c.organizationId, id);
    if (record === undefined || record.caseId !== c.caseId) return { ok: false, missing: true };
    const loaded = await deps.evidence.load(c.organizationId, id);
    if (!loaded.ok || !loaded.value.integrity.valid) return { ok: false, missing: false };
    return { ok: true, pkg: loaded.value.package };
  }

  async function authorizeCase(
    actor: ActorContext,
    caseId: string,
    anyOfScopes: readonly ConsentScope[],
    endpoint: string,
  ): Promise<
    Result<
      { c: RiskImprovementCase; decision: Extract<AccessDecision, { allowed: true }> },
      InsuranceError
    >
  > {
    const agreements = await myAgreements(actor);
    const c = await locateCase(agreements, caseId);
    if (c === undefined) {
      // unknown to this recipient: audited under the requester, same answer as "not consented"
      return fail(
        await deny(
          actor,
          { organizationId: actor.organizationId, facilityId: "UNSCOPED" },
          { type: "CASE", id: caseId },
          "NO_AGREEMENT_FOR_TARGET",
          "TARGET_NOT_REACHABLE_THROUGH_ANY_AGREEMENT",
          endpoint,
        ),
      );
    }
    const decision = evaluateAccess(agreements, {
      recipientOrganizationId: actor.organizationId,
      ownerOrganizationId: c.organizationId,
      facilityId: c.facilityId,
      anyOfScopes,
      nowMs: deps.clock.nowMs(),
    });
    if (!decision.allowed) {
      return fail(
        await deny(
          actor,
          { organizationId: c.organizationId, facilityId: c.facilityId, caseId: c.caseId },
          { type: "CASE", id: c.caseId },
          decision.reason,
          decision.internalReason,
          endpoint,
        ),
      );
    }
    return ok({ c, decision });
  }

  async function allowedAudit(
    actor: ActorContext,
    c: { readonly organizationId: string; readonly facilityId: string; readonly caseId?: string },
    endpoint: string,
    decision: Extract<AccessDecision, { allowed: true }>,
    extra: Record<string, string | number | boolean | readonly string[]> = {},
  ): Promise<InsuranceError | undefined> {
    try {
      await auditEntry(
        actor,
        {
          organizationId: c.organizationId,
          facilityId: c.facilityId,
          ...(c.caseId !== undefined && { caseId: c.caseId }),
        },
        "INSURER_EVIDENCE_READ",
        {
          type: c.caseId !== undefined ? "CASE" : "SHARING_AGREEMENT",
          id: c.caseId ?? decision.agreementIds[0] ?? "NONE",
        },
        {
          endpoint,
          agreementIds: [...decision.agreementIds],
          grantedScopes: [...decision.grantedScopes],
          ...extra,
        },
      );
      return undefined;
    } catch {
      return {
        code: "AUDIT_FAILURE",
        message: "The read could not be audited, so nothing was released",
      };
    }
  }

  async function projected(
    c: RiskImprovementCase,
    decision: Extract<AccessDecision, { allowed: true }>,
    packageId?: string,
  ): Promise<
    | { readonly ok: true; readonly view: InsurerCaseView; readonly pkg?: EvidencePackage }
    | { readonly ok: false; readonly missing: boolean }
  > {
    // The package is only loaded when some granted scope can release part of it.
    const needsPackage = EVIDENCE_PACKAGE_SCOPES.some((s) => decision.grantedScopes.includes(s));
    const loaded = needsPackage ? await loadVerifiedPackage(c, packageId) : ({ ok: true } as const);
    if (!loaded.ok) return loaded;
    const view = projectCase({
      caseRecord: c,
      agreementIds: decision.agreementIds,
      grantedScopes: decision.grantedScopes,
      ...(loaded.pkg !== undefined && { pkg: loaded.pkg }),
    });
    return { ok: true, view, ...(loaded.pkg !== undefined && { pkg: loaded.pkg }) };
  }

  /** Visible sites: facility x owner pairs covered by an ACTIVE agreement right now. */
  function activeSites(agreements: readonly SharingAgreement[]) {
    const nowMs = deps.clock.nowMs();
    const out = new Map<
      string,
      { owner: string; facilityId: string; agreements: SharingAgreement[] }
    >();
    for (const a of agreements) {
      if (agreementStatus(a, nowMs) !== "ACTIVE") continue;
      for (const f of a.facilityIds) {
        const key = `${a.organizationId}|${f}`;
        const entry = out.get(key) ?? { owner: a.organizationId, facilityId: f, agreements: [] };
        entry.agreements.push(a);
        out.set(key, entry);
      }
    }
    return [...out.values()];
  }

  return {
    async sites(actor) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const sites = activeSites(await myAgreements(actor));
      try {
        for (const owner of new Set(sites.map((s) => s.owner))) {
          const mine = sites.filter((s) => s.owner === owner);
          await auditEntry(
            actor,
            { organizationId: owner, facilityId: mine[0]?.facilityId ?? "UNSCOPED" },
            "INSURER_EVIDENCE_READ",
            { type: "SHARING_AGREEMENT", id: mine[0]?.agreements[0]?.agreementId ?? "NONE" },
            {
              endpoint: "GET /insurance/v1/sites",
              siteIds: mine.map((s) => s.facilityId),
              resultCount: mine.length,
            },
          );
        }
      } catch {
        return fail({ code: "AUDIT_FAILURE", message: "The read could not be audited" });
      }
      return ok(
        sites.map((s) => ({
          siteId: s.facilityId,
          insuredOrganizationId: s.owner,
          agreements: s.agreements.map((a) => ({
            agreementId: a.agreementId,
            scopes: a.scopes,
            effectiveFrom: a.effectiveFrom,
            ...(a.expiresAt !== undefined && { expiresAt: a.expiresAt }),
          })),
        })),
      );
    },

    async casesForSite(actor, siteId) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const agreements = await myAgreements(actor);
      const owners = [
        ...new Set(
          agreements.filter((a) => a.facilityIds.includes(siteId)).map((a) => a.organizationId),
        ),
      ];
      if (owners.length === 0) {
        return fail(
          await deny(
            actor,
            { organizationId: actor.organizationId, facilityId: "UNSCOPED" },
            { type: "SHARING_AGREEMENT", id: "NONE" },
            "NO_AGREEMENT_FOR_TARGET",
            "NO_AGREEMENT_COVERS_SITE",
            "GET /insurance/v1/sites/:id/cases",
          ),
        );
      }
      const views: InsurerCaseView[] = [];
      let lastDenial: InsuranceError | undefined;
      for (const owner of owners) {
        const decision = evaluateAccess(agreements, {
          recipientOrganizationId: actor.organizationId,
          ownerOrganizationId: owner,
          facilityId: siteId,
          anyOfScopes: ANY_SCOPE_FOR_LISTING,
          nowMs: deps.clock.nowMs(),
        });
        if (!decision.allowed) {
          lastDenial = await deny(
            actor,
            { organizationId: owner, facilityId: siteId },
            { type: "SHARING_AGREEMENT", id: "NONE" },
            decision.reason,
            decision.internalReason,
            "GET /insurance/v1/sites/:id/cases",
          );
          continue;
        }
        const cases = (await deps.cases.list(owner)).filter((c) => c.facilityId === siteId);
        for (const c of cases) {
          const p = await projected(c, decision);
          if (!p.ok) {
            // a package that fails verification is withheld, never partially shown
            lastDenial = await deny(
              actor,
              { organizationId: owner, facilityId: siteId, caseId: c.caseId },
              { type: "CASE", id: c.caseId },
              "EVIDENCE_INTEGRITY_FAILURE",
              "PACKAGE_UNVERIFIABLE",
              "GET /insurance/v1/sites/:id/cases",
            );
            continue;
          }
          views.push(p.view);
        }
        const audited = await allowedAudit(
          actor,
          { organizationId: owner, facilityId: siteId },
          "GET /insurance/v1/sites/:id/cases",
          decision,
          { resultCount: cases.length },
        );
        if (audited !== undefined) return fail(audited);
      }
      if (views.length === 0 && lastDenial !== undefined) return fail(lastDenial);
      return ok(views);
    },

    async caseView(actor, caseId) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const endpoint = "GET /insurance/v1/cases/:id";
      const auth = await authorizeCase(actor, caseId, ANY_SCOPE_FOR_LISTING, endpoint);
      if (!auth.ok) return auth;
      const { c, decision } = auth.value;
      const p = await projected(c, decision);
      if (!p.ok) {
        return fail(
          await deny(
            actor,
            { organizationId: c.organizationId, facilityId: c.facilityId, caseId: c.caseId },
            { type: "CASE", id: c.caseId },
            "EVIDENCE_INTEGRITY_FAILURE",
            "PACKAGE_UNVERIFIABLE",
            endpoint,
          ),
        );
      }
      const audited = await allowedAudit(actor, c, endpoint, decision, {
        ...(p.pkg !== undefined && { evidencePackageId: p.pkg.packageId }),
      });
      if (audited !== undefined) return fail(audited);
      return ok(p.view);
    },

    async evidence(actor, caseId, options = {}) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const endpoint = options.includeRawTelemetry
        ? "GET /insurance/v1/cases/:id/evidence?include=raw_telemetry"
        : "GET /insurance/v1/cases/:id/evidence";
      // The evidence endpoint releases package content, so a package scope is required.
      const auth = await authorizeCase(
        actor,
        caseId,
        options.includeRawTelemetry === true
          ? EVIDENCE_PACKAGE_SCOPES
          : EVIDENCE_PACKAGE_SCOPES.filter((s) => s !== "RAW_TELEMETRY"),
        endpoint,
      );
      if (!auth.ok) return auth;
      const { c, decision } = auth.value;
      if (
        options.includeRawTelemetry === true &&
        !decision.grantedScopes.includes("RAW_TELEMETRY")
      ) {
        // asking for raw telemetry without the explicit scope is a denial, not a silent omission
        return fail(
          await deny(
            actor,
            { organizationId: c.organizationId, facilityId: c.facilityId, caseId: c.caseId },
            { type: "CASE", id: c.caseId },
            "SCOPE_NOT_GRANTED",
            "SCOPE_NOT_GRANTED:RAW_TELEMETRY",
            endpoint,
          ),
        );
      }
      const p = await projected(c, decision, options.packageId);
      if (!p.ok) {
        if (p.missing) return fail({ code: "NOT_FOUND", message: "Evidence package not found" });
        return fail(
          await deny(
            actor,
            { organizationId: c.organizationId, facilityId: c.facilityId, caseId: c.caseId },
            {
              type: "EVIDENCE_PACKAGE",
              id: options.packageId ?? c.latestEvidencePackageId ?? c.caseId,
            },
            "EVIDENCE_INTEGRITY_FAILURE",
            "PACKAGE_UNVERIFIABLE",
            endpoint,
          ),
        );
      }
      const history = decision.grantedScopes.includes("EVIDENCE_ARTIFACTS")
        ? (await deps.packages.listByCase(c.organizationId, c.caseId)).map((r) => ({
            packageId: r.packageId,
            createdAt: r.createdAt,
            ...(decision.grantedScopes.includes("VERIFICATION_RESULT") && { result: r.result }),
          }))
        : undefined;
      const view: InsurerEvidenceView = {
        ...p.view,
        ...(history !== undefined && { packageHistory: history }),
        ...(options.includeRawTelemetry === true &&
          p.pkg !== undefined && { rawTelemetry: projectRawTelemetry(p.pkg) }),
      };
      const audited = await allowedAudit(actor, c, endpoint, decision, {
        ...(p.pkg !== undefined && { evidencePackageId: p.pkg.packageId }),
        rawTelemetryReleased: view.rawTelemetry !== undefined,
      });
      if (audited !== undefined) return fail(audited);
      return ok(view);
    },

    async recommendations(actor) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const agreements = await myAgreements(actor);
      const out: InsurerCaseView[] = [];
      for (const site of activeSites(agreements)) {
        const decision = evaluateAccess(agreements, {
          recipientOrganizationId: actor.organizationId,
          ownerOrganizationId: site.owner,
          facilityId: site.facilityId,
          anyOfScopes: ["RECOMMENDATION"],
          nowMs: deps.clock.nowMs(),
        });
        if (!decision.allowed) continue; // not consented for recommendations: simply absent
        const cases = (await deps.cases.list(site.owner)).filter(
          (c) => c.facilityId === site.facilityId,
        );
        for (const c of cases) {
          // recommendation scope only: no package-derived section is ever added here
          out.push(
            projectCase({
              caseRecord: c,
              agreementIds: decision.agreementIds,
              grantedScopes: decision.grantedScopes.filter((s) => s === "RECOMMENDATION"),
            }),
          );
        }
        const audited = await allowedAudit(
          actor,
          { organizationId: site.owner, facilityId: site.facilityId },
          "GET /insurance/v1/recommendations",
          decision,
          { resultCount: cases.length },
        );
        if (audited !== undefined) return fail(audited);
      }
      return ok(out);
    },

    async interventions(actor) {
      const bad = requireRole(actor);
      if (bad !== undefined) return fail(bad);
      const agreements = await myAgreements(actor);
      const out: InsurerInterventionView[] = [];
      for (const site of activeSites(agreements)) {
        const decision = evaluateAccess(agreements, {
          recipientOrganizationId: actor.organizationId,
          ownerOrganizationId: site.owner,
          facilityId: site.facilityId,
          anyOfScopes: ["INTERVENTION_RECOMMENDATION"],
          nowMs: deps.clock.nowMs(),
        });
        if (!decision.allowed) continue;
        const current = (await deps.interventions.list(site.owner)).filter(
          (r) =>
            r.facilityId === site.facilityId &&
            (r.status === "ACTIVE" || r.status === "ACKNOWLEDGED"),
        );
        out.push(...current.map(projectIntervention));
        const audited = await allowedAudit(
          actor,
          { organizationId: site.owner, facilityId: site.facilityId },
          "GET /insurance/v1/interventions",
          decision,
          { resultCount: current.length },
        );
        if (audited !== undefined) return fail(audited);
      }
      return ok(out);
    },
  };
}
