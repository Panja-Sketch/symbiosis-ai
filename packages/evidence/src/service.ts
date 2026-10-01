import { err, ok } from "@symbiosis/contracts";
import type {
  AuditEntry,
  Baseline,
  CanonicalObservation,
  EvidencePackage,
  EvidencePackageRecord,
  MitigationAction,
  Result,
  VerificationAttempt,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { can } from "@symbiosis/authz";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator, Unsubscribe } from "@symbiosis/event-bus";
import type {
  ActionRepository,
  BaselineRepository,
  CaseRepository,
  EvidencePackageRepository,
  ObservationRepository,
  RiskEventRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import { applyCaseDocumentation } from "@symbiosis/risk-cases";
import { canAccessFacility } from "@symbiosis/tenancy";
import type { ActorContext } from "@symbiosis/tenancy";
import { buildEvidencePackage } from "./builder";
import type { ApprovedActionFact, EvidenceError, PolicyDocument } from "./builder";
import { canonicalJson } from "./canonical";
import { sha256OfText } from "./hash";
import { evidenceObjectKey } from "./store";
import type { EvidenceObjectStore } from "./store";
import { verifyEvidencePackage } from "./verify";
import type { EvidenceIntegrity } from "./verify";

export type EvidenceServiceDeps = {
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly audit: AuditLog;
  readonly cases: CaseRepository;
  readonly riskEvents: RiskEventRepository;
  readonly actions: ActionRepository;
  readonly observations: ObservationRepository;
  readonly baselines: BaselineRepository;
  readonly verifications: VerificationRepository;
  readonly packages: EvidencePackageRepository;
  readonly store: EvidenceObjectStore;
  /** Verification policies in force; each referenced POLICY artifact must be one of these. */
  readonly policies: readonly PolicyDocument[];
  /** Approved actions for a hazard, from the versioned action library. */
  approvedActionsFor(hazardType: string): readonly ApprovedActionFact[];
};

export type LoadedEvidence = {
  readonly package: EvidencePackage;
  readonly record: EvidencePackageRecord;
  /** Recomputed on every load; a package that fails it must not be shared or relied on. */
  readonly integrity: EvidenceIntegrity;
};

export type CreatedEvidence = {
  readonly record: EvidencePackageRecord;
  /** False when the verification already had a package (idempotent redelivery). */
  readonly created: boolean;
};

export type EvidenceService = {
  /**
   * Builds, stores and registers the package for one COMPLETED verification, links it to the case
   * (`latestEvidencePackageId`) and emits `evidence.package_created.v1`. Idempotent per
   * verification. It never changes a verification result, a risk state or any source record.
   */
  createForVerification(
    organizationId: string,
    verificationId: string,
    context?: { readonly correlationId?: string; readonly causationId?: string },
  ): Promise<Result<CreatedEvidence, EvidenceError>>;
  /** Retries every completed verification that has no package yet (scheduler seam). */
  createMissing(): Promise<{
    readonly created: readonly string[];
    readonly failures: readonly {
      readonly verificationId: string;
      readonly error: EvidenceError;
    }[];
  }>;
  /** System-level load (no actor): used by the consent gateway after its own authorization. */
  load(organizationId: string, packageId: string): Promise<Result<LoadedEvidence, EvidenceError>>;
  /** Actor read: needs EVIDENCE_READ and facility access; audited. */
  getForActor(
    actor: ActorContext,
    packageId: string,
  ): Promise<Result<LoadedEvidence, EvidenceError>>;
  /** Package history of one case (metadata only), oldest first. */
  listForCase(
    actor: ActorContext,
    caseId: string,
  ): Promise<Result<readonly EvidencePackageRecord[], EvidenceError>>;
};

const fail = (code: EvidenceError["code"], message: string, details?: readonly string[]) =>
  err<EvidenceError>({ code, message, ...(details !== undefined && { details }) });

export function createEvidenceService(deps: EvidenceServiceDeps): EvidenceService {
  async function create(
    organizationId: string,
    verificationId: string,
    context: { readonly correlationId?: string; readonly causationId?: string } = {},
  ): Promise<Result<CreatedEvidence, EvidenceError>> {
    const attempt = await deps.verifications.get(organizationId, verificationId);
    if (attempt === undefined) return fail("NOT_FOUND", "Verification not found");
    if (attempt.status !== "COMPLETED" || attempt.assessment === undefined) {
      return fail("VERIFICATION_NOT_COMPLETED", "The verification is not completed");
    }

    const existing = await deps.packages.getByVerification(organizationId, verificationId);
    if (existing !== undefined) return ok({ record: existing, created: false });

    const caseRecord = await deps.cases.get(organizationId, attempt.caseId);
    const event = await deps.riskEvents.get(organizationId, attempt.eventId);
    if (caseRecord === undefined || event === undefined) {
      return fail("UNRESOLVED_EVIDENCE", "The case or risk event of the verification is missing", [
        ...(caseRecord === undefined ? [`CASE:${attempt.caseId}`] : []),
        ...(event === undefined ? [`RISK_EVENT:${attempt.eventId}`] : []),
      ]);
    }

    const references = attempt.evidenceReferences ?? [];
    const auditEntries = await deps.audit.listByCase(organizationId, attempt.caseId);
    const observations: CanonicalObservation[] = [];
    const baselines: Baseline[] = [];
    const actionsById = new Map<string, MitigationAction>();
    for (const ref of references) {
      if (ref.kind === "OBSERVATION") {
        const o = await deps.observations.get(organizationId, ref.id);
        if (o !== undefined) observations.push(o);
      } else if (ref.kind === "BASELINE") {
        const b = await deps.baselines.getById(organizationId, ref.id);
        if (b !== undefined) baselines.push(b);
      }
    }
    const wantedActions = new Set([
      ...attempt.actionIds,
      ...references.filter((r) => r.kind === "ACTION").map((r) => r.id),
    ]);
    for (const id of wantedActions) {
      const a = await deps.actions.get(organizationId, id);
      if (a !== undefined) actionsById.set(id, a);
    }
    const priorAttempts: VerificationAttempt[] = (
      await deps.verifications.listByCase(organizationId, attempt.caseId)
    ).filter(
      (a) => a.status === "COMPLETED" && Date.parse(a.startedAt) < Date.parse(attempt.startedAt),
    );

    const createdAt = nowIso(deps.clock);
    const packageId = deps.ids.next("EVP");
    const built = buildEvidencePackage({
      packageId,
      createdAt,
      caseRecord,
      event,
      attempt,
      priorAttempts,
      actions: [...actionsById.values()],
      observations,
      baselines,
      auditEntries,
      policies: deps.policies,
      approvedActions: deps.approvedActionsFor(caseRecord.hazardType),
    });
    if (!built.ok) return built;
    const pkg = built.value;

    let text: string;
    try {
      text = canonicalJson(pkg);
    } catch (e) {
      return fail("SERIALIZATION_FAILURE", e instanceof Error ? e.message : String(e));
    }
    const verified = verifyEvidencePackage(pkg);
    if (!verified.valid) {
      return fail("INTEGRITY_FAILURE", "A freshly built package failed its own verification", [
        ...verified.issues,
      ]);
    }

    const objectKey = evidenceObjectKey(organizationId, pkg.packageId);
    const record: EvidencePackageRecord = {
      packageId: pkg.packageId,
      organizationId,
      facilityId: pkg.facilityId,
      caseId: pkg.caseId,
      verificationId: pkg.verificationId,
      result: pkg.payload.verification.result,
      createdAt: pkg.createdAt,
      verificationEvaluatedAt: pkg.payload.verification.evaluatedAt,
      schemaVersion: pkg.schemaVersion,
      payloadSha256: pkg.manifest.payloadSha256,
      manifestSha256: pkg.manifestSha256,
      objectKey,
      byteLength: Buffer.byteLength(text, "utf8"),
    };

    // Nothing is overwritten: the object store and the index both refuse an existing id. A storage
    // error is an explicit failure (no package, no case link, no event), never a partial success.
    try {
      if (!(await deps.store.putIfAbsent(objectKey, text))) {
        return fail("STORAGE_FAILURE", "An object already exists under the package key");
      }
      if (!(await deps.packages.insertIfAbsent(record))) {
        const raced = await deps.packages.getByVerification(organizationId, verificationId);
        return raced !== undefined
          ? ok({ record: raced, created: false })
          : fail("STORAGE_FAILURE", "The package could not be registered");
      }
    } catch (e) {
      return fail("STORAGE_FAILURE", e instanceof Error ? e.message : String(e));
    }

    // Case linkage is documentation, not a lifecycle change. An older verification completed
    // late never displaces a newer package as "latest".
    const current = await deps.cases.get(organizationId, pkg.caseId);
    if (current !== undefined) {
      const latest =
        current.latestEvidencePackageId === undefined
          ? undefined
          : await deps.packages.get(organizationId, current.latestEvidencePackageId);
      const newer =
        latest !== undefined &&
        Date.parse(latest.verificationEvaluatedAt) > Date.parse(record.verificationEvaluatedAt);
      if (!newer) {
        const linked = applyCaseDocumentation(current, {
          type: "RECORD_EVIDENCE_PACKAGE",
          evidencePackageId: pkg.packageId,
        });
        if (!linked.ok) {
          return fail("INCONSISTENT_SOURCE", linked.error.message);
        }
        await deps.cases.save(linked.value);
      }
    }

    const correlationId = context.correlationId ?? attempt.correlationId;
    await deps.audit.append({
      organizationId,
      facilityId: pkg.facilityId,
      caseId: pkg.caseId,
      actorId: "SYSTEM-EVIDENCE",
      actorType: "SYSTEM",
      action: "EVIDENCE_PACKAGE_CREATED",
      targetType: "EVIDENCE_PACKAGE",
      targetId: pkg.packageId,
      correlationId,
      at: pkg.createdAt,
      details: {
        verificationId: pkg.verificationId,
        result: record.result,
        policyId: pkg.payload.verification.policyId,
        policyVersion: pkg.payload.verification.policyVersion,
        payloadSha256: record.payloadSha256,
        manifestSha256: record.manifestSha256,
        artifactCount: pkg.manifest.artifactCount,
        dataOrigin: pkg.payload.source.dataOrigin,
      },
    });
    await deps.bus.publish(
      createEnvelope(deps.ids, {
        type: "evidence.package_created.v1",
        correlationId,
        causationId: context.causationId ?? null,
        organizationId,
        facilityId: pkg.facilityId,
        occurredAt: pkg.createdAt,
        producer: "worker",
        payload: {
          evidencePackageId: pkg.packageId,
          caseId: pkg.caseId,
          riskEventId: pkg.payload.riskEvent.eventId,
          verificationId: pkg.verificationId,
          result: record.result,
          policyId: pkg.payload.verification.policyId,
          policyVersion: pkg.payload.verification.policyVersion,
          schemaVersion: pkg.schemaVersion,
          payloadSha256: record.payloadSha256,
          manifestSha256: record.manifestSha256,
          artifactCount: pkg.manifest.artifactCount,
          dataOrigin: pkg.payload.source.dataOrigin,
          createdAt: pkg.createdAt,
        },
      }),
    );
    return ok({ record, created: true });
  }

  async function load(
    organizationId: string,
    packageId: string,
  ): Promise<Result<LoadedEvidence, EvidenceError>> {
    const record = await deps.packages.get(organizationId, packageId);
    if (record === undefined) return fail("NOT_FOUND", "Evidence package not found");
    const text = await deps.store.get(record.objectKey);
    if (text === undefined) {
      return fail("INTEGRITY_FAILURE", "The stored package bytes are missing", ["OBJECT_MISSING"]);
    }
    let pkg: EvidencePackage;
    try {
      pkg = JSON.parse(text) as EvidencePackage;
    } catch {
      return fail("INTEGRITY_FAILURE", "The stored package is not valid JSON", [
        "OBJECT_UNPARSEABLE",
      ]);
    }
    const integrity = verifyEvidencePackage(pkg);
    const issues = [...integrity.issues];
    if (sha256OfText(canonicalJson(pkg)) !== sha256OfText(text))
      issues.push("STORED_BYTES_NOT_CANONICAL");
    if (pkg.packageId !== record.packageId) issues.push("INDEX_MISMATCH:PACKAGE_ID");
    if (pkg.organizationId !== record.organizationId) issues.push("INDEX_MISMATCH:ORGANIZATION");
    if (pkg.manifestSha256 !== record.manifestSha256) issues.push("INDEX_MISMATCH:MANIFEST_HASH");
    if (pkg.manifest.payloadSha256 !== record.payloadSha256) {
      issues.push("INDEX_MISMATCH:PAYLOAD_HASH");
    }
    return ok({
      package: pkg,
      record,
      integrity: { ...integrity, valid: issues.length === 0, issues },
    });
  }

  return {
    createForVerification: create,

    async createMissing() {
      const created: string[] = [];
      const failures: { verificationId: string; error: EvidenceError }[] = [];
      for (const a of await deps.verifications.listAllForSystemTick()) {
        if (a.status !== "COMPLETED") continue;
        if (
          (await deps.packages.getByVerification(a.organizationId, a.verificationId)) !== undefined
        ) {
          continue;
        }
        const r = await create(a.organizationId, a.verificationId);
        if (r.ok) {
          if (r.value.created) created.push(r.value.record.packageId);
        } else failures.push({ verificationId: a.verificationId, error: r.error });
      }
      return { created, failures };
    },

    load,

    async getForActor(actor, packageId) {
      if (!can(actor, "EVIDENCE_READ")) {
        return fail("FORBIDDEN", "Missing permission EVIDENCE_READ");
      }
      const loaded = await load(actor.organizationId, packageId); // organization-scoped
      if (!loaded.ok) return loaded;
      if (!canAccessFacility(actor, loaded.value.record.facilityId)) {
        // indistinguishable from a package that does not exist
        return fail("NOT_FOUND", "Evidence package not found");
      }
      const entry: Omit<AuditEntry, "auditId" | "sequence"> = {
        organizationId: actor.organizationId,
        facilityId: loaded.value.record.facilityId,
        caseId: loaded.value.record.caseId,
        actorId: actor.actorId,
        actorType: "USER",
        action: "EVIDENCE_PACKAGE_READ",
        targetType: "EVIDENCE_PACKAGE",
        targetId: packageId,
        correlationId: deps.ids.next("CORR"),
        at: nowIso(deps.clock),
        details: { integrityValid: loaded.value.integrity.valid },
      };
      await deps.audit.append(entry);
      return loaded;
    },

    async listForCase(actor, caseId) {
      if (!can(actor, "EVIDENCE_READ")) {
        return fail("FORBIDDEN", "Missing permission EVIDENCE_READ");
      }
      const c = await deps.cases.get(actor.organizationId, caseId);
      if (c === undefined || !canAccessFacility(actor, c.facilityId)) {
        return fail("NOT_FOUND", "Case not found");
      }
      return ok(await deps.packages.listByCase(actor.organizationId, caseId));
    },
  };
}

/**
 * Worker wiring: every completed verification (VERIFIED, PARTIALLY_VERIFIED, NOT_IMPROVING and
 * INCONCLUSIVE alike, D-047) gets an evidence package that preserves its actual result. A
 * failure throws so the bus dead-letters it explicitly; the scheduler retries via createMissing.
 */
export function startEvidenceBuilder(
  deps: { readonly bus: EventBus },
  service: EvidenceService,
): Unsubscribe {
  return deps.bus.subscribe("verification.completed.v1", async (event) => {
    const r = await service.createForVerification(
      event.organization_id,
      event.payload.verificationId,
      {
        correlationId: event.correlation_id,
        causationId: event.event_id,
      },
    );
    if (!r.ok) {
      throw new Error(
        `evidence package failed for ${event.payload.verificationId}: ${r.error.code}: ${r.error.message}` +
          (r.error.details !== undefined ? ` [${r.error.details.join(", ")}]` : ""),
      );
    }
  });
}
