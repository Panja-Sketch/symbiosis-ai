import { baselineKeyString, observationDedupeKey } from "@symbiosis/contracts";
import type {
  Baseline,
  BaselineAuditRecord,
  BaselineKey,
  BaselineSnapshot,
  CanonicalObservation,
  DetectionState,
  RiskEvent,
  RiskImprovementCase,
} from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/repositories" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/**
 * Canonical observation store. Uniqueness is the architecture dedupe identity
 * (device_id + signal + observed_at). Only the S2 need is modelled here; Firestore (S9)
 * must satisfy the same interface. Every query is organization-scoped.
 */
export interface ObservationRepository {
  /** Stores the observation; returns false (and stores nothing) if its dedupe key exists. */
  insertIfAbsent(observation: CanonicalObservation): Promise<boolean>;
  list(organizationId: string): Promise<readonly CanonicalObservation[]>;
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
}

/**
 * Baseline store. Every version is kept (history is never overwritten); `getActive` returns
 * the newest non-superseded baseline for a key. Queries are organization-scoped.
 */
export interface BaselineRepository {
  save(baseline: Baseline): Promise<void>;
  getActive(key: BaselineKey): Promise<Baseline | undefined>;
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
