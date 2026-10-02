import { baselineKeyString, observationDedupeKey } from "@symbiosis/contracts";
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

export const PACKAGE_NAME = "@symbiosis/repositories" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export * from "./tenant-documents";

/**
 * Canonical observation store. Uniqueness is the architecture dedupe identity
 * (device_id + signal + observed_at). Only the S2 need is modelled here; Firestore (S9)
 * must satisfy the same interface. Every query is organization-scoped.
 */
export interface ObservationRepository {
  /** Stores the observation; returns false (and stores nothing) if its dedupe key exists. */
  insertIfAbsent(observation: CanonicalObservation): Promise<boolean>;
  list(organizationId: string): Promise<readonly CanonicalObservation[]>;
  get(organizationId: string, observationId: string): Promise<CanonicalObservation | undefined>;
  /**
   * Observations of one facility whose observed_at lies in [fromIso, toIso] (inclusive), for the
   * given assets, oldest first. Always organization- and facility-scoped.
   */
  listForWindow(query: {
    readonly organizationId: string;
    readonly facilityId: string;
    readonly assetIds: readonly string[];
    readonly fromIso: string;
    readonly toIso: string;
  }): Promise<readonly CanonicalObservation[]>;
}

export class InMemoryObservationRepository implements ObservationRepository {
  private readonly byKey = new Map<string, CanonicalObservation>();

  async insertIfAbsent(observation: CanonicalObservation): Promise<boolean> {
    const key = observationDedupeKey(observation);
    if (this.byKey.has(key)) return false;
    this.byKey.set(key, observation);
    return true;
  }

  async list(organizationId: string): Promise<readonly CanonicalObservation[]> {
    return [...this.byKey.values()].filter((o) => o.organizationId === organizationId);
  }

  async get(organizationId: string, observationId: string) {
    return [...this.byKey.values()].find(
      (o) => o.organizationId === organizationId && o.observationId === observationId,
    );
  }

  async listForWindow(query: {
    readonly organizationId: string;
    readonly facilityId: string;
    readonly assetIds: readonly string[];
    readonly fromIso: string;
    readonly toIso: string;
  }): Promise<readonly CanonicalObservation[]> {
    const from = Date.parse(query.fromIso);
    const to = Date.parse(query.toIso);
    return [...this.byKey.values()]
      .filter(
        (o) =>
          o.organizationId === query.organizationId &&
          o.facilityId === query.facilityId &&
          query.assetIds.includes(o.assetId) &&
          Date.parse(o.observedAt) >= from &&
          Date.parse(o.observedAt) <= to,
      )
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  }
}

/**
 * Baseline store. Every version is kept (history is never overwritten); `getActive` returns
 * the newest non-superseded baseline for a key. Queries are organization-scoped.
 */
export interface BaselineRepository {
  save(baseline: Baseline): Promise<void>;
  getActive(key: BaselineKey): Promise<Baseline | undefined>;
  /** Any version (also a superseded one), if it belongs to the organization. */
  getById(organizationId: string, baselineId: string): Promise<Baseline | undefined>;
  /** Active (non-superseded) baselines of a facility, for risk evaluation. */
  listActive(organizationId: string, facilityId: string): Promise<readonly Baseline[]>;
  /** All versions for a key, oldest first. */
  history(key: BaselineKey): Promise<readonly Baseline[]>;
  saveSnapshot(snapshot: BaselineSnapshot): Promise<void>;
  getSnapshot(organizationId: string, snapshotId: string): Promise<BaselineSnapshot | undefined>;
  appendAudit(record: BaselineAuditRecord): Promise<void>;
  listAudit(organizationId: string): Promise<readonly BaselineAuditRecord[]>;
}

export class InMemoryBaselineRepository implements BaselineRepository {
  private readonly byId = new Map<string, Baseline>();
  private readonly snapshots = new Map<string, BaselineSnapshot>();
  private readonly audit: BaselineAuditRecord[] = [];

  async save(baseline: Baseline): Promise<void> {
    this.byId.set(baseline.baselineId, baseline);
  }

  async history(key: BaselineKey): Promise<readonly Baseline[]> {
    const k = baselineKeyString(key);
    return [...this.byId.values()]
      .filter((b) => baselineKeyString(b.key) === k)
      .sort((a, b) => a.version - b.version);
  }

  async getById(organizationId: string, baselineId: string) {
    const b = this.byId.get(baselineId);
    return b !== undefined && b.key.organizationId === organizationId ? b : undefined;
  }

  async getActive(key: BaselineKey): Promise<Baseline | undefined> {
    const all = (await this.history(key)).filter((b) => b.status !== "SUPERSEDED");
    return all.at(-1);
  }

  async listActive(organizationId: string, facilityId: string): Promise<readonly Baseline[]> {
    const latest = new Map<string, Baseline>();
    for (const b of this.byId.values()) {
      if (b.key.organizationId !== organizationId || b.key.facilityId !== facilityId) continue;
      if (b.status === "SUPERSEDED") continue;
      const k = baselineKeyString(b.key);
      const prior = latest.get(k);
      if (prior === undefined || prior.version < b.version) latest.set(k, b);
    }
    return [...latest.values()];
  }

  async saveSnapshot(snapshot: BaselineSnapshot): Promise<void> {
    this.snapshots.set(`${snapshot.organizationId}|${snapshot.snapshotId}`, snapshot);
  }

  async getSnapshot(organizationId: string, snapshotId: string) {
    return this.snapshots.get(`${organizationId}|${snapshotId}`);
  }

  async appendAudit(record: BaselineAuditRecord): Promise<void> {
    this.audit.push(record);
  }

  async listAudit(organizationId: string): Promise<readonly BaselineAuditRecord[]> {
    return this.audit.filter((a) => a.key.organizationId === organizationId);
  }
}

export interface DetectionStateRepository {
  get(stateKey: string): Promise<DetectionState | undefined>;
  save(state: DetectionState): Promise<void>;
}

export class InMemoryDetectionStateRepository implements DetectionStateRepository {
  private readonly states = new Map<string, DetectionState>();

  async get(stateKey: string): Promise<DetectionState | undefined> {
    return this.states.get(stateKey);
  }

  async save(state: DetectionState): Promise<void> {
    this.states.set(state.stateKey, state);
  }
}

/** Case store. Correlation convention: the primary asset is `assetIds[0]`. */
export interface CaseRepository {
  save(c: RiskImprovementCase): Promise<void>;
  get(organizationId: string, caseId: string): Promise<RiskImprovementCase | undefined>;
  list(organizationId: string): Promise<readonly RiskImprovementCase[]>;
  /** Unresolved case for the same organization + facility + hazard + primary asset. */
  findActive(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ): Promise<RiskImprovementCase | undefined>;
  /**
   * VERIFIED_IMPROVED cases of the same episode identity (organization + facility + hazard +
   * primary asset), most recently updated first. Recurrence matching starts from these.
   */
  findVerifiedImproved(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ): Promise<readonly RiskImprovementCase[]>;
  /** Every case across tenants, for the system-level verification tick only. */
  listAllForSystemTick(): Promise<readonly RiskImprovementCase[]>;
}

export class InMemoryCaseRepository implements CaseRepository {
  private readonly cases = new Map<string, RiskImprovementCase>();

  async save(c: RiskImprovementCase): Promise<void> {
    this.cases.set(`${c.organizationId}|${c.caseId}`, c);
  }

  async get(organizationId: string, caseId: string) {
    return this.cases.get(`${organizationId}|${caseId}`);
  }

  async list(organizationId: string): Promise<readonly RiskImprovementCase[]> {
    return [...this.cases.values()].filter((c) => c.organizationId === organizationId);
  }

  async findActive(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ): Promise<RiskImprovementCase | undefined> {
    return [...this.cases.values()].find(
      (c) =>
        c.organizationId === organizationId &&
        c.facilityId === facilityId &&
        c.hazardType === hazardType &&
        c.assetIds[0] === primaryAssetId &&
        c.state !== "CLOSED" &&
        c.state !== "VERIFIED_IMPROVED",
    );
  }

  async findVerifiedImproved(
    organizationId: string,
    facilityId: string,
    hazardType: string,
    primaryAssetId: string,
  ): Promise<readonly RiskImprovementCase[]> {
    return [...this.cases.values()]
      .filter(
        (c) =>
          c.organizationId === organizationId &&
          c.facilityId === facilityId &&
          c.hazardType === hazardType &&
          c.assetIds[0] === primaryAssetId &&
          c.state === "VERIFIED_IMPROVED",
      )
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async listAllForSystemTick(): Promise<readonly RiskImprovementCase[]> {
    return [...this.cases.values()];
  }
}

export interface RiskEventRepository {
  save(event: RiskEvent): Promise<void>;
  get(organizationId: string, eventId: string): Promise<RiskEvent | undefined>;
  listByCase(organizationId: string, caseId: string): Promise<readonly RiskEvent[]>;
}

export class InMemoryRiskEventRepository implements RiskEventRepository {
  private readonly events = new Map<string, RiskEvent>();

  async save(event: RiskEvent): Promise<void> {
    this.events.set(`${event.organizationId}|${event.eventId}`, event);
  }

  async get(organizationId: string, eventId: string) {
    return this.events.get(`${organizationId}|${eventId}`);
  }

  async listByCase(organizationId: string, caseId: string): Promise<readonly RiskEvent[]> {
    return [...this.events.values()].filter(
      (e) => e.organizationId === organizationId && e.caseId === caseId,
    );
  }
}

/** Alert store. Escalations are separate alerts, so history is never overwritten. */
export interface AlertRepository {
  save(alert: Alert): Promise<void>;
  get(organizationId: string, alertId: string): Promise<Alert | undefined>;
  listByCase(organizationId: string, caseId: string): Promise<readonly Alert[]>;
  /** Every alert across tenants, for the system-level escalation/retry tick only. */
  listAllForSystemTick(): Promise<readonly Alert[]>;
}

export class InMemoryAlertRepository implements AlertRepository {
  private readonly alerts = new Map<string, Alert>();

  async save(alert: Alert): Promise<void> {
    this.alerts.set(`${alert.organizationId}|${alert.alertId}`, alert);
  }

  async get(organizationId: string, alertId: string) {
    return this.alerts.get(`${organizationId}|${alertId}`);
  }

  async listByCase(organizationId: string, caseId: string): Promise<readonly Alert[]> {
    return [...this.alerts.values()].filter(
      (a) => a.organizationId === organizationId && a.caseId === caseId,
    );
  }

  async listAllForSystemTick(): Promise<readonly Alert[]> {
    return [...this.alerts.values()];
  }
}

/** Mitigation-action store (RECOMMEND_ONLY records of human assignment and reporting). */
export interface ActionRepository {
  save(organizationId: string, action: MitigationAction): Promise<void>;
  get(organizationId: string, actionId: string): Promise<MitigationAction | undefined>;
  listByCase(organizationId: string, caseId: string): Promise<readonly MitigationAction[]>;
}

export class InMemoryActionRepository implements ActionRepository {
  private readonly actions = new Map<string, MitigationAction>();

  async save(organizationId: string, action: MitigationAction): Promise<void> {
    this.actions.set(`${organizationId}|${action.actionId}`, { ...action, organizationId });
  }

  async get(organizationId: string, actionId: string) {
    return this.actions.get(`${organizationId}|${actionId}`);
  }

  async listByCase(organizationId: string, caseId: string): Promise<readonly MitigationAction[]> {
    return [...this.actions.values()].filter(
      (a) => a.organizationId === organizationId && a.caseId === caseId,
    );
  }
}

/**
 * Verification attempts. History is never overwritten: an IN_PROGRESS attempt may be replaced
 * by its COMPLETED form once, and a COMPLETED attempt can never be saved again.
 */
export interface VerificationRepository {
  save(attempt: VerificationAttempt): Promise<void>;
  get(organizationId: string, verificationId: string): Promise<VerificationAttempt | undefined>;
  /** Oldest first. */
  listByCase(organizationId: string, caseId: string): Promise<readonly VerificationAttempt[]>;
  /** Every attempt across tenants, for the system-level verification tick only. */
  listAllForSystemTick(): Promise<readonly VerificationAttempt[]>;
}

export class InMemoryVerificationRepository implements VerificationRepository {
  private readonly attempts = new Map<string, VerificationAttempt>();

  async save(attempt: VerificationAttempt): Promise<void> {
    const key = `${attempt.organizationId}|${attempt.verificationId}`;
    if (this.attempts.get(key)?.status === "COMPLETED") {
      throw new Error(`verification ${attempt.verificationId} is completed and immutable`);
    }
    this.attempts.set(key, attempt);
  }

  async get(organizationId: string, verificationId: string) {
    return this.attempts.get(`${organizationId}|${verificationId}`);
  }

  async listByCase(
    organizationId: string,
    caseId: string,
  ): Promise<readonly VerificationAttempt[]> {
    return [...this.attempts.values()]
      .filter((a) => a.organizationId === organizationId && a.caseId === caseId)
      .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  async listAllForSystemTick(): Promise<readonly VerificationAttempt[]> {
    return [...this.attempts.values()];
  }
}

/** Intervention recommendations; superseded ones stay for audit. Organization-scoped. */
export interface InterventionRepository {
  save(recommendation: RiskEngineerInterventionRecommendation): Promise<void>;
  get(
    organizationId: string,
    interventionId: string,
  ): Promise<RiskEngineerInterventionRecommendation | undefined>;
  /** Oldest first. */
  list(organizationId: string): Promise<readonly RiskEngineerInterventionRecommendation[]>;
  listByCase(
    organizationId: string,
    caseId: string,
  ): Promise<readonly RiskEngineerInterventionRecommendation[]>;
}

export class InMemoryInterventionRepository implements InterventionRepository {
  private readonly items = new Map<string, RiskEngineerInterventionRecommendation>();

  async save(r: RiskEngineerInterventionRecommendation): Promise<void> {
    this.items.set(`${r.organizationId}|${r.interventionId}`, r);
  }

  async get(organizationId: string, interventionId: string) {
    return this.items.get(`${organizationId}|${interventionId}`);
  }

  async list(organizationId: string) {
    return [...this.items.values()]
      .filter((r) => r.organizationId === organizationId)
      .sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));
  }

  async listByCase(organizationId: string, caseId: string) {
    return (await this.list(organizationId)).filter((r) => r.caseId === caseId);
  }
}

/**
 * Index of immutable evidence packages (the package bytes live in the evidence object store).
 * A package is never updated or deleted, and a verification has at most one package, so a
 * redelivered `verification.completed` cannot create a second one. Organization-scoped.
 */
export interface EvidencePackageRepository {
  /** False (and nothing stored) when the package id or the verification already has a package. */
  insertIfAbsent(record: EvidencePackageRecord): Promise<boolean>;
  get(organizationId: string, packageId: string): Promise<EvidencePackageRecord | undefined>;
  getByVerification(
    organizationId: string,
    verificationId: string,
  ): Promise<EvidencePackageRecord | undefined>;
  /** Oldest first; the whole history stays available. */
  listByCase(organizationId: string, caseId: string): Promise<readonly EvidencePackageRecord[]>;
}

export class InMemoryEvidencePackageRepository implements EvidencePackageRepository {
  private readonly records = new Map<string, EvidencePackageRecord>();

  async insertIfAbsent(record: EvidencePackageRecord): Promise<boolean> {
    const key = `${record.organizationId}|${record.packageId}`;
    if (this.records.has(key)) return false;
    for (const r of this.records.values()) {
      if (
        r.organizationId === record.organizationId &&
        r.verificationId === record.verificationId
      ) {
        return false;
      }
    }
    this.records.set(key, Object.freeze({ ...record }));
    return true;
  }

  async get(organizationId: string, packageId: string) {
    return this.records.get(`${organizationId}|${packageId}`);
  }

  async getByVerification(organizationId: string, verificationId: string) {
    return [...this.records.values()].find(
      (r) => r.organizationId === organizationId && r.verificationId === verificationId,
    );
  }

  async listByCase(organizationId: string, caseId: string) {
    return [...this.records.values()]
      .filter((r) => r.organizationId === organizationId && r.caseId === caseId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
}

export type RevokeAgreementResult =
  | { readonly status: "REVOKED"; readonly agreement: SharingAgreement }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "ALREADY_REVOKED"; readonly agreement: SharingAgreement };

/**
 * Sharing agreements. History is preserved: an agreement is never deleted, and revocation only
 * sets its revocation metadata once (it can never be un-revoked or have its terms rewritten).
 * Owner reads are scoped by the granting organization; recipient reads by the recipient.
 */
export interface SharingAgreementRepository {
  /** Throws if the agreement id already exists. */
  insert(agreement: SharingAgreement): Promise<void>;
  getForOwner(organizationId: string, agreementId: string): Promise<SharingAgreement | undefined>;
  listForOwner(organizationId: string): Promise<readonly SharingAgreement[]>;
  listForRecipient(recipientOrganizationId: string): Promise<readonly SharingAgreement[]>;
  revoke(
    organizationId: string,
    agreementId: string,
    revocation: {
      readonly revokedAt: string;
      readonly revokedBy: string;
      readonly reason?: string;
    },
  ): Promise<RevokeAgreementResult>;
  /** Every agreement across tenants, for the system-level expiry reconciliation only. */
  listAllForSystemTick(): Promise<readonly SharingAgreement[]>;
}

export class InMemorySharingAgreementRepository implements SharingAgreementRepository {
  private readonly items = new Map<string, SharingAgreement>();

  async insert(agreement: SharingAgreement): Promise<void> {
    if (this.items.has(agreement.agreementId)) {
      throw new Error(`sharing agreement ${agreement.agreementId} already exists`);
    }
    this.items.set(agreement.agreementId, Object.freeze({ ...agreement }));
  }

  async getForOwner(organizationId: string, agreementId: string) {
    const a = this.items.get(agreementId);
    return a !== undefined && a.organizationId === organizationId ? a : undefined;
  }

  async listForOwner(organizationId: string) {
    return [...this.items.values()]
      .filter((a) => a.organizationId === organizationId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async listForRecipient(recipientOrganizationId: string) {
    return [...this.items.values()]
      .filter((a) => a.recipientOrganizationId === recipientOrganizationId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async revoke(
    organizationId: string,
    agreementId: string,
    revocation: {
      readonly revokedAt: string;
      readonly revokedBy: string;
      readonly reason?: string;
    },
  ): Promise<RevokeAgreementResult> {
    // No await between the read and the write: revocation must be atomic (found by the shared
    // contract suite, which revokes concurrently).
    const found = this.items.get(agreementId);
    const current =
      found !== undefined && found.organizationId === organizationId ? found : undefined;
    if (current === undefined) return { status: "NOT_FOUND" };
    if (current.revokedAt !== undefined) return { status: "ALREADY_REVOKED", agreement: current };
    const next: SharingAgreement = Object.freeze({
      ...current,
      revokedAt: revocation.revokedAt,
      revokedBy: revocation.revokedBy,
      ...(revocation.reason !== undefined && { revocationReason: revocation.reason }),
    });
    this.items.set(agreementId, next);
    return { status: "REVOKED", agreement: next };
  }

  async listAllForSystemTick() {
    return [...this.items.values()];
  }
}

/** Ledger of evidence made available to a recipient: unique per agreement + package. */
export interface SharedEvidenceRepository {
  insertIfAbsent(record: SharedEvidenceRecord): Promise<boolean>;
  listByCase(organizationId: string, caseId: string): Promise<readonly SharedEvidenceRecord[]>;
  listByAgreement(
    organizationId: string,
    agreementId: string,
  ): Promise<readonly SharedEvidenceRecord[]>;
}

export class InMemorySharedEvidenceRepository implements SharedEvidenceRepository {
  private readonly items = new Map<string, SharedEvidenceRecord>();

  async insertIfAbsent(record: SharedEvidenceRecord): Promise<boolean> {
    const key = `${record.agreementId}|${record.evidencePackageId}`;
    if (this.items.has(key)) return false;
    this.items.set(key, Object.freeze({ ...record }));
    return true;
  }

  async listByCase(organizationId: string, caseId: string) {
    return [...this.items.values()].filter(
      (r) => r.organizationId === organizationId && r.caseId === caseId,
    );
  }

  async listByAgreement(organizationId: string, agreementId: string) {
    return [...this.items.values()].filter(
      (r) => r.organizationId === organizationId && r.agreementId === agreementId,
    );
  }
}
