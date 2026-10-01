import { randomUUID } from "node:crypto";
import { afterAll, inject } from "vitest";
import {
  Firestore,
  FirestoreActionRepository,
  FirestoreAlertRepository,
  FirestoreAuditLog,
  FirestoreBaselineRepository,
  FirestoreCaseRepository,
  FirestoreDetectionStateRepository,
  FirestoreDeviceRegistry,
  FirestoreEvidencePackageRepository,
  FirestoreObservationRepository,
  FirestoreReplayGuard,
  FirestoreRiskEventRepository,
  FirestoreSharedEvidenceRepository,
  FirestoreSharingAgreementRepository,
  FirestoreVerificationRepository,
} from "@symbiosis/adapter-gcp";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { InMemoryDeviceRegistry } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import {
  InMemoryActionRepository,
  InMemoryAlertRepository,
  InMemoryBaselineRepository,
  InMemoryCaseRepository,
  InMemoryDetectionStateRepository,
  InMemoryEvidencePackageRepository,
  InMemoryObservationRepository,
  InMemoryRiskEventRepository,
  InMemorySharedEvidenceRepository,
  InMemorySharingAgreementRepository,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import { repositoryContract } from "./repository-contract";
import type { Adapters } from "./repository-contract";

// The in-memory registry takes its records in the constructor, so seed the contract's device.
repositoryContract("in-memory", () => {
  const device = {
    deviceId: "DEV-1",
    organizationId: "ORG-A",
    facilityId: "FAC-1",
    assetId: "AST-1",
    status: "ACTIVE",
    activeKeyId: "KEY-1",
    expectedSignals: ["temperature"],
    capabilities: ["telemetry"],
    health: "UNKNOWN",
  } as const;
  return {
    observations: new InMemoryObservationRepository(),
    baselines: new InMemoryBaselineRepository(),
    detectionStates: new InMemoryDetectionStateRepository(),
    cases: new InMemoryCaseRepository(),
    riskEvents: new InMemoryRiskEventRepository(),
    alerts: new InMemoryAlertRepository(),
    actions: new InMemoryActionRepository(),
    verifications: new InMemoryVerificationRepository(),
    evidencePackages: new InMemoryEvidencePackageRepository(),
    agreements: new InMemorySharingAgreementRepository(),
    shares: new InMemorySharedEvidenceRepository(),
    audit: new InMemoryAuditLog(),
    registry: new InMemoryDeviceRegistry([device]),
    replay: new InMemoryReplayGuard(),
  } satisfies Adapters;
});

const host = inject("firestoreEmulatorHost");
const firestores: Firestore[] = [];

function firestoreAdapters(): Adapters {
  // Fresh collection prefix per test: isolated state, nothing to clean up in the emulator.
  const db = new Firestore({
    projectId: "demo-symbiosis-contract",
    host: host ?? "127.0.0.1:1",
    ssl: false,
    customHeaders: { Authorization: "Bearer owner" },
  });
  firestores.push(db);
  const o = { db, collectionPrefix: `t${randomUUID().replaceAll("-", "").slice(0, 12)}_` };
  return {
    observations: new FirestoreObservationRepository(o),
    baselines: new FirestoreBaselineRepository(o),
    detectionStates: new FirestoreDetectionStateRepository(o),
    cases: new FirestoreCaseRepository(o),
    riskEvents: new FirestoreRiskEventRepository(o),
    alerts: new FirestoreAlertRepository(o),
    actions: new FirestoreActionRepository(o),
    verifications: new FirestoreVerificationRepository(o),
    evidencePackages: new FirestoreEvidencePackageRepository(o),
    agreements: new FirestoreSharingAgreementRepository(o),
    shares: new FirestoreSharedEvidenceRepository(o),
    audit: new FirestoreAuditLog(o),
    registry: new FirestoreDeviceRegistry(o),
    replay: new FirestoreReplayGuard(o),
  };
}

// Skipped (loudly, in global setup) only when no emulator could be started; CI sets
// SYMBIOSIS_REQUIRE_EMULATOR=1 so a missing emulator fails instead.
repositoryContract("firestore (emulator)", firestoreAdapters, { skip: host === null });

afterAll(async () => {
  await Promise.all(firestores.map((f) => f.terminate()));
});
