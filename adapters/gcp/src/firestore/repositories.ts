import { baselineKeyString, observationDedupeKey } from "@symbiosis/contracts";
import type { Query } from "@google-cloud/firestore";
import type {
  Alert,
  Baseline,
  BaselineAuditRecord,
  BaselineKey,
  BaselineSnapshot,
  CanonicalObservation,
  DetectionState,
  EvidencePackageRecord,
  MitigationAction,
  RiskEngineerInterventionRecommendation,
  RiskEvent,
  RiskImprovementCase,
  SharedEvidenceRecord,
  SharingAgreement,
  VerificationAttempt,
} from "@symbiosis/contracts";
import type {
  ActionRepository,
  AlertRepository,
  BaselineRepository,
  CaseRepository,
  DetectionStateRepository,
  EvidencePackageRepository,
  InterventionRepository,
  ObservationRepository,
  RevokeAgreementResult,
  RiskEventRepository,
  SharedEvidenceRepository,
  SharingAgreementRepository,
  VerificationRepository,
} from "@symbiosis/repositories";
import {
  COLLECTIONS as C,
  createCtx,
  decode,
  encode,
  isAlreadyExists,
  ms,
  sha256Hex,
  storedFields,
  tenantDocId,
} from "./common";
import type { Ctx, FirestoreAdapterOptions } from "./common";

/**
 * Firestore implementations of the repository ports (S9). Same observable behavior as the
 * in-memory ones, which the shared contract suite proves against the emulator:
 *  - tenant-owned documents are addressed `<org>~<id>`, so another tenant's id is "not found";
 *  - uniqueness rules (observation dedupe, one package per verification, one share per
 *    agreement+package, completed verifications immutable, revoke-once) are enforced with
 *    `create()` (atomic ALREADY_EXISTS) or a Firestore transaction, never read-then-write;
 *  - every write stamps `storedAt` (infrastructure time); domain times stay inside `json`.
 *
 * Each repository is a single-document-per-record design: one `save` is one atomic write. The
 * services above still persist several records one after another (as they did locally); see
 * docs/GCP_RUNTIME.md "Transaction boundaries" for what that means and how redelivery recovers.
 */

type Doc = Record<string, unknown>;

async function getDoc<T>(ctx: Ctx, collection: string, id: string): Promise<T | undefined> {
  const snap = await ctx.col(collection).doc(id).get();
  return snap.exists ? decode<T>(snap.data()) : undefined;
}

async function queryDocs<T>(
  ctx: Ctx,
  collection: string,
  filters: readonly (readonly [string, "==" | ">=" | "<=" | "array-contains", unknown])[],
): Promise<T[]> {
  let q: Query = ctx.col(collection);
  for (const [field, op, value] of filters) q = q.where(field, op, value);
  const snap = await q.get();
  return snap.docs.map((d) => decode<T>(d.data()) as T);
}

async function putDoc(ctx: Ctx, collection: string, id: string, fields: Doc, record: unknown) {
  await ctx
    .col(collection)
    .doc(id)
    .set({ ...fields, json: encode(record), ...storedFields(ctx) });
}

const byIso = <T>(pick: (t: T) => string) => {
  return (a: T, b: T) => ms(pick(a)) - ms(pick(b));
};

export class FirestoreObservationRepository implements ObservationRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async insertIfAbsent(o: CanonicalObservation): Promise<boolean> {
    const ref = this.ctx.col(C.observations).doc(sha256Hex(observationDedupeKey(o)));
    try {
      await ref.create({
        organizationId: o.organizationId,
        facilityId: o.facilityId,
        assetId: o.assetId,
        observationId: o.observationId,
        observedAtMs: ms(o.observedAt),
        json: encode(o),
        ...storedFields(this.ctx),
      });
      return true;
    } catch (e) {
      if (isAlreadyExists(e)) return false;
      throw e;
    }
  }

  list(organizationId: string) {
    return queryDocs<CanonicalObservation>(this.ctx, C.observations, [
      ["organizationId", "==", organizationId],
    ]);
  }

  async get(organizationId: string, observationId: string) {
    const [one] = await queryDocs<CanonicalObservation>(this.ctx, C.observations, [
      ["organizationId", "==", organizationId],
      ["observationId", "==", observationId],
    ]);
    return one;
  }

  async listForWindow(query: {
    readonly organizationId: string;
    readonly facilityId: string;
    readonly assetIds: readonly string[];
    readonly fromIso: string;
    readonly toIso: string;
  }): Promise<readonly CanonicalObservation[]> {
    // Composite index: organizationId ASC, facilityId ASC, observedAtMs ASC.
    const found = await queryDocs<CanonicalObservation>(this.ctx, C.observations, [
      ["organizationId", "==", query.organizationId],
      ["facilityId", "==", query.facilityId],
      ["observedAtMs", ">=", ms(query.fromIso)],
      ["observedAtMs", "<=", ms(query.toIso)],
    ]);
    return found.filter((o) => query.assetIds.includes(o.assetId)).sort(byIso((o) => o.observedAt));
  }
}

export class FirestoreBaselineRepository implements BaselineRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(b: Baseline): Promise<void> {
    await putDoc(
      this.ctx,
      C.baselines,
      tenantDocId(b.key.organizationId, b.baselineId),
      {
        organizationId: b.key.organizationId,
        facilityId: b.key.facilityId,
        keyString: baselineKeyString(b.key),
        version: b.version,
        status: b.status,
      },
      b,
    );
  }

  async history(key: BaselineKey): Promise<readonly Baseline[]> {
    const all = await queryDocs<Baseline>(this.ctx, C.baselines, [
      ["organizationId", "==", key.organizationId],
      ["keyString", "==", baselineKeyString(key)],
    ]);
    return all.sort((a, b) => a.version - b.version);
  }

  getById(organizationId: string, baselineId: string) {
    return getDoc<Baseline>(this.ctx, C.baselines, tenantDocId(organizationId, baselineId));
  }

  async getActive(key: BaselineKey) {
    return (await this.history(key)).filter((b) => b.status !== "SUPERSEDED").at(-1);
  }

  async listActive(organizationId: string, facilityId: string): Promise<readonly Baseline[]> {
    const all = await queryDocs<Baseline>(this.ctx, C.baselines, [
      ["organizationId", "==", organizationId],
      ["facilityId", "==", facilityId],
    ]);
    const latest = new Map<string, Baseline>();
    for (const b of all) {
      if (b.status === "SUPERSEDED") continue;
      const k = baselineKeyString(b.key);
      const prior = latest.get(k);
      if (prior === undefined || prior.version < b.version) latest.set(k, b);
    }
    return [...latest.values()];
  }

  async saveSnapshot(s: BaselineSnapshot): Promise<void> {
    await putDoc(
      this.ctx,
      C.baselineSnapshots,
      tenantDocId(s.organizationId, s.snapshotId),
      { organizationId: s.organizationId },
      s,
    );
  }

  getSnapshot(organizationId: string, snapshotId: string) {
    return getDoc<BaselineSnapshot>(
      this.ctx,
      C.baselineSnapshots,
      tenantDocId(organizationId, snapshotId),
    );
  }

  async appendAudit(record: BaselineAuditRecord): Promise<void> {
    // Append-only: a fresh auto id per record, ordered by infrastructure time then id.
    const ref = this.ctx.col(C.baselineAudit).doc();
    await ref.create({
      organizationId: record.key.organizationId,
      seq: this.ctx.now().getTime(),
      json: encode(record),
      ...storedFields(this.ctx),
    });
  }

  async listAudit(organizationId: string): Promise<readonly BaselineAuditRecord[]> {
    const snap = await this.ctx
      .col(C.baselineAudit)
      .where("organizationId", "==", organizationId)
      .get();
    return snap.docs
      .map((d) => ({
        seq: d.get("seq") as number,
        id: d.id,
        rec: decode<BaselineAuditRecord>(d.data()) as BaselineAuditRecord,
      }))
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
      .map((x) => x.rec);
  }
}

export class FirestoreDetectionStateRepository implements DetectionStateRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  get(stateKey: string) {
    return getDoc<DetectionState>(this.ctx, C.detectionStates, sha256Hex(stateKey));
  }

  async save(state: DetectionState): Promise<void> {
    await putDoc(
      this.ctx,
      C.detectionStates,
      sha256Hex(state.stateKey),
      { organizationId: state.organizationId, facilityId: state.facilityId },
      state,
    );
  }
}

export class FirestoreCaseRepository implements CaseRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(c: RiskImprovementCase): Promise<void> {
    await putDoc(
      this.ctx,
      C.cases,
      tenantDocId(c.organizationId, c.caseId),
      {
        organizationId: c.organizationId,
        facilityId: c.facilityId,
        hazardType: c.hazardType,
        primaryAssetId: c.assetIds[0] ?? "",
        state: c.state,
        updatedAtMs: ms(c.updatedAt),
      },
      c,
    );
  }

  get(organizationId: string, caseId: string) {
    return getDoc<RiskImprovementCase>(this.ctx, C.cases, tenantDocId(organizationId, caseId));
  }

  list(organizationId: string) {
    return queryDocs<RiskImprovementCase>(this.ctx, C.cases, [
      ["organizationId", "==", organizationId],
    ]);
  }

  private episode(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ) {
    return queryDocs<RiskImprovementCase>(this.ctx, C.cases, [
      ["organizationId", "==", organizationId],
      ["facilityId", "==", facilityId],
      ["hazardType", "==", hazardType],
      ["primaryAssetId", "==", primaryAssetId],
    ]);
  }

  async findActive(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ) {
    const all = await this.episode(organizationId, facilityId, hazardType, primaryAssetId);
    return all.find((c) => c.state !== "CLOSED" && c.state !== "VERIFIED_IMPROVED");
  }

  async findVerifiedImproved(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ): Promise<readonly RiskImprovementCase[]> {
    const all = await this.episode(organizationId, facilityId, hazardType, primaryAssetId);
    return all
      .filter((c) => c.state === "VERIFIED_IMPROVED")
      .sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
  }

  async listAllForSystemTick(): Promise<readonly RiskImprovementCase[]> {
    const snap = await this.ctx.col(C.cases).get();
    return snap.docs.map((d) => decode<RiskImprovementCase>(d.data()) as RiskImprovementCase);
  }
}

export class FirestoreRiskEventRepository implements RiskEventRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(e: RiskEvent): Promise<void> {
    await putDoc(
      this.ctx,
      C.riskEvents,
      tenantDocId(e.organizationId, e.eventId),
      { organizationId: e.organizationId, caseId: e.caseId },
      e,
    );
  }

  get(organizationId: string, eventId: string) {
    return getDoc<RiskEvent>(this.ctx, C.riskEvents, tenantDocId(organizationId, eventId));
  }

  listByCase(organizationId: string, caseId: string) {
    return queryDocs<RiskEvent>(this.ctx, C.riskEvents, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
  }
}

export class FirestoreAlertRepository implements AlertRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(a: Alert): Promise<void> {
    await putDoc(
      this.ctx,
      C.alerts,
      tenantDocId(a.organizationId, a.alertId),
      { organizationId: a.organizationId, caseId: a.caseId },
      a,
    );
  }

  get(organizationId: string, alertId: string) {
    return getDoc<Alert>(this.ctx, C.alerts, tenantDocId(organizationId, alertId));
  }

  listByCase(organizationId: string, caseId: string) {
    return queryDocs<Alert>(this.ctx, C.alerts, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
  }

  async listAllForSystemTick(): Promise<readonly Alert[]> {
    const snap = await this.ctx.col(C.alerts).get();
    return snap.docs.map((d) => decode<Alert>(d.data()) as Alert);
  }
}

export class FirestoreActionRepository implements ActionRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(organizationId: string, action: MitigationAction): Promise<void> {
    await putDoc(
      this.ctx,
      C.actions,
      tenantDocId(organizationId, action.actionId),
      { organizationId, caseId: action.caseId },
      { ...action, organizationId },
    );
  }

  get(organizationId: string, actionId: string) {
    return getDoc<MitigationAction>(this.ctx, C.actions, tenantDocId(organizationId, actionId));
  }

  listByCase(organizationId: string, caseId: string) {
    return queryDocs<MitigationAction>(this.ctx, C.actions, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
  }
}

export class FirestoreVerificationRepository implements VerificationRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  /** Transaction: a COMPLETED attempt can never be replaced, even by a concurrent writer. */
  async save(attempt: VerificationAttempt): Promise<void> {
    const ref = this.ctx
      .col(C.verifications)
      .doc(tenantDocId(attempt.organizationId, attempt.verificationId));
    await this.ctx.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && decode<VerificationAttempt>(snap.data())?.status === "COMPLETED") {
        throw new Error(`verification ${attempt.verificationId} is completed and immutable`);
      }
      tx.set(ref, {
        organizationId: attempt.organizationId,
        caseId: attempt.caseId,
        startedAtMs: ms(attempt.startedAt),
        status: attempt.status,
        json: encode(attempt),
        ...storedFields(this.ctx),
      });
    });
  }

  get(organizationId: string, verificationId: string) {
    return getDoc<VerificationAttempt>(
      this.ctx,
      C.verifications,
      tenantDocId(organizationId, verificationId),
    );
  }

  async listByCase(
    organizationId: string,
    caseId: string,
  ): Promise<readonly VerificationAttempt[]> {
    const all = await queryDocs<VerificationAttempt>(this.ctx, C.verifications, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
    return all.sort(byIso((a) => a.startedAt));
  }

  async listAllForSystemTick(): Promise<readonly VerificationAttempt[]> {
    const snap = await this.ctx.col(C.verifications).get();
    return snap.docs.map((d) => decode<VerificationAttempt>(d.data()) as VerificationAttempt);
  }
}

export class FirestoreInterventionRepository implements InterventionRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async save(r: RiskEngineerInterventionRecommendation): Promise<void> {
    await putDoc(
      this.ctx,
      C.interventions,
      tenantDocId(r.organizationId, r.interventionId),
      { organizationId: r.organizationId, caseId: r.caseId },
      r,
    );
  }

  get(organizationId: string, interventionId: string) {
    return getDoc<RiskEngineerInterventionRecommendation>(
      this.ctx,
      C.interventions,
      tenantDocId(organizationId, interventionId),
    );
  }

  async list(organizationId: string) {
    const all = await queryDocs<RiskEngineerInterventionRecommendation>(this.ctx, C.interventions, [
      ["organizationId", "==", organizationId],
    ]);
    return all.sort(byIso((r) => r.generatedAt));
  }

  async listByCase(organizationId: string, caseId: string) {
    return (await this.list(organizationId)).filter((r) => r.caseId === caseId);
  }
}

export class FirestoreEvidencePackageRepository implements EvidencePackageRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  /**
   * Transaction over two documents: the package record and a per-verification uniqueness anchor.
   * Either both are created or neither (false when the package id or the verification is taken).
   */
  async insertIfAbsent(record: EvidencePackageRecord): Promise<boolean> {
    const pkgRef = this.ctx
      .col(C.evidencePackages)
      .doc(tenantDocId(record.organizationId, record.packageId));
    const anchorRef = this.ctx
      .col(C.evidencePackageByVerification)
      .doc(tenantDocId(record.organizationId, record.verificationId));
    return this.ctx.db.runTransaction(async (tx) => {
      const [pkg, anchor] = await Promise.all([tx.get(pkgRef), tx.get(anchorRef)]);
      if (pkg.exists || anchor.exists) return false;
      const stored = storedFields(this.ctx);
      tx.create(pkgRef, {
        organizationId: record.organizationId,
        caseId: record.caseId,
        verificationId: record.verificationId,
        createdAtMs: ms(record.createdAt),
        json: encode(record),
        ...stored,
      });
      tx.create(anchorRef, {
        organizationId: record.organizationId,
        packageId: record.packageId,
        ...stored,
      });
      return true;
    });
  }

  get(organizationId: string, packageId: string) {
    return getDoc<EvidencePackageRecord>(
      this.ctx,
      C.evidencePackages,
      tenantDocId(organizationId, packageId),
    );
  }

  async getByVerification(organizationId: string, verificationId: string) {
    const [one] = await queryDocs<EvidencePackageRecord>(this.ctx, C.evidencePackages, [
      ["organizationId", "==", organizationId],
      ["verificationId", "==", verificationId],
    ]);
    return one;
  }

  async listByCase(organizationId: string, caseId: string) {
    const all = await queryDocs<EvidencePackageRecord>(this.ctx, C.evidencePackages, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
    return all.sort(byIso((r) => r.createdAt));
  }
}

export class FirestoreSharingAgreementRepository implements SharingAgreementRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  private fields(a: SharingAgreement) {
    return {
      organizationId: a.organizationId,
      recipientOrganizationId: a.recipientOrganizationId,
      createdAtMs: ms(a.createdAt),
    };
  }

  async insert(a: SharingAgreement): Promise<void> {
    try {
      await this.ctx
        .col(C.sharingAgreements)
        .doc(a.agreementId)
        .create({ ...this.fields(a), json: encode(a), ...storedFields(this.ctx) });
    } catch (e) {
      if (isAlreadyExists(e)) throw new Error(`sharing agreement ${a.agreementId} already exists`);
      throw e;
    }
  }

  async getForOwner(organizationId: string, agreementId: string) {
    const a = await getDoc<SharingAgreement>(this.ctx, C.sharingAgreements, agreementId);
    return a !== undefined && a.organizationId === organizationId ? a : undefined;
  }

  async listForOwner(organizationId: string) {
    const all = await queryDocs<SharingAgreement>(this.ctx, C.sharingAgreements, [
      ["organizationId", "==", organizationId],
    ]);
    return all.sort(byIso((a) => a.createdAt));
  }

  async listForRecipient(recipientOrganizationId: string) {
    const all = await queryDocs<SharingAgreement>(this.ctx, C.sharingAgreements, [
      ["recipientOrganizationId", "==", recipientOrganizationId],
    ]);
    return all.sort(byIso((a) => a.createdAt));
  }

  /** Transaction: revocation is set exactly once and terms are never rewritten. */
  async revoke(
    organizationId: string,
    agreementId: string,
    revocation: {
      readonly revokedAt: string;
      readonly revokedBy: string;
      readonly reason?: string;
    },
  ): Promise<RevokeAgreementResult> {
    const ref = this.ctx.col(C.sharingAgreements).doc(agreementId);
    return this.ctx.db.runTransaction(async (tx): Promise<RevokeAgreementResult> => {
      const snap = await tx.get(ref);
      const current = snap.exists ? decode<SharingAgreement>(snap.data()) : undefined;
      if (current === undefined || current.organizationId !== organizationId) {
        return { status: "NOT_FOUND" };
      }
      if (current.revokedAt !== undefined) return { status: "ALREADY_REVOKED", agreement: current };
      const next: SharingAgreement = {
        ...current,
        revokedAt: revocation.revokedAt,
        revokedBy: revocation.revokedBy,
        ...(revocation.reason !== undefined && { revocationReason: revocation.reason }),
      };
      tx.update(ref, { json: encode(next), ...storedFields(this.ctx) });
      return { status: "REVOKED", agreement: next };
    });
  }

  async listAllForSystemTick() {
    const snap = await this.ctx.col(C.sharingAgreements).get();
    return snap.docs.map((d) => decode<SharingAgreement>(d.data()) as SharingAgreement);
  }
}

export class FirestoreSharedEvidenceRepository implements SharedEvidenceRepository {
  private readonly ctx: Ctx;
  constructor(options: FirestoreAdapterOptions) {
    this.ctx = createCtx(options);
  }

  async insertIfAbsent(r: SharedEvidenceRecord): Promise<boolean> {
    const ref = this.ctx.col(C.sharedEvidence).doc(`${r.agreementId}~${r.evidencePackageId}`);
    try {
      await ref.create({
        organizationId: r.organizationId,
        caseId: r.caseId,
        agreementId: r.agreementId,
        json: encode(r),
        ...storedFields(this.ctx),
      });
      return true;
    } catch (e) {
      if (isAlreadyExists(e)) return false;
      throw e;
    }
  }

  listByCase(organizationId: string, caseId: string) {
    return queryDocs<SharedEvidenceRecord>(this.ctx, C.sharedEvidence, [
      ["organizationId", "==", organizationId],
      ["caseId", "==", caseId],
    ]);
  }

  listByAgreement(organizationId: string, agreementId: string) {
    return queryDocs<SharedEvidenceRecord>(this.ctx, C.sharedEvidence, [
      ["organizationId", "==", organizationId],
      ["agreementId", "==", agreementId],
    ]);
  }
}
