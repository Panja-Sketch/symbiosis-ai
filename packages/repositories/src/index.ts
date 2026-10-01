import { observationDedupeKey } from "@symbiosis/contracts";
import type { CanonicalObservation } from "@symbiosis/contracts";

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
