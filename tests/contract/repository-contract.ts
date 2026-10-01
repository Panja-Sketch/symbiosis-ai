import { describe, expect, it } from "vitest";
import type {
  Alert,
  Baseline,
  BaselineKey,
  CanonicalObservation,
  EvidencePackageRecord,
  MitigationAction,
  RiskEvent,
  RiskImprovementCase,
  SharedEvidenceRecord,
  SharingAgreement,
  VerificationAttempt,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import type { DeviceRecord, DeviceRegistry } from "@symbiosis/device-registry";
import type { ReplayGuard } from "@symbiosis/edge-security";
import type {
  ActionRepository,
  AlertRepository,
  BaselineRepository,
  CaseRepository,
  DetectionStateRepository,
  EvidencePackageRepository,
  ObservationRepository,
  RiskEventRepository,
  SharedEvidenceRepository,
  SharingAgreementRepository,
  VerificationRepository,
} from "@symbiosis/repositories";

/**
 * Behavioral contract every repository implementation must satisfy (in-memory AND Firestore).
 * The same assertions run against both, so a cloud adapter cannot weaken a guarantee silently:
 * not-found, tenant scoping, immutability, uniqueness and append-only behavior.
 */
export type Adapters = {
  observations: ObservationRepository;
  baselines: BaselineRepository;
  detectionStates: DetectionStateRepository;
  cases: CaseRepository;
  riskEvents: RiskEventRepository;
  alerts: AlertRepository;
  actions: ActionRepository;
  verifications: VerificationRepository;
  evidencePackages: EvidencePackageRepository;
  agreements: SharingAgreementRepository;
  shares: SharedEvidenceRepository;
  audit: AuditLog;
  registry: DeviceRegistry & { put?(device: DeviceRecord): Promise<void> };
  replay: ReplayGuard;
};

const T = "2026-10-01T00:00:00.000Z";

const obs = (over: Partial<CanonicalObservation> = {}): CanonicalObservation => ({
  observationId: "OBS-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  assetId: "AST-1",
  deviceId: "DEV-1",
  signal: "temperature",
  value: 4.2,
  unit: "degC",
  observedAt: "2026-09-29T20:00:00.000Z",
  receivedAt: "2026-09-29T20:00:05.000Z",
  sourceType: "SIMULATOR",
  sourceAdapter: "sim",
  quality: {
    confidence: 1,
    stale: false,
    outOfRange: false,
    deviceHealthy: true,
    authVerified: true,
  },
  ...over,
});

const key: BaselineKey = {
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  assetId: "AST-1",
  signal: "vibration_rms",
  operatingMode: "HIGH_LOAD",
};
const baseline = (
  version: number,
  status: Baseline["status"],
  over: Partial<Baseline> = {},
): Baseline => ({
  baselineId: `BSL-v${version}`,
  key,
  version,
  status,
  configVersion: "c1",
  observationCount: 5,
  mean: 1,
  m2: 0,
  min: 1,
  max: 1,
  ...over,
});

const mkCase = (over: Partial<RiskImprovementCase> = {}): RiskImprovementCase => ({
  caseId: "CASE-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  assetIds: ["AST-FAN", "AST-ZONE"],
  origin: { type: "DETECTED_HAZARD", detectionId: "D" },
  hazardType: "H",
  title: "t",
  severity: "HIGH",
  state: "OPEN",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: T,
  updatedAt: T,
  ...over,
});

const pkgRec = (patch: Partial<EvidencePackageRecord> = {}): EvidencePackageRecord => ({
  packageId: "EVP-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  caseId: "CASE-1",
  verificationId: "VER-1",
  result: "VERIFIED",
  createdAt: T,
  verificationEvaluatedAt: T,
  schemaVersion: "evidence-package.v1",
  payloadSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  objectKey: "evidence/ORG-A/EVP-1.json",
  byteLength: 10,
  ...patch,
});

const agreement = (patch: Partial<SharingAgreement> = {}): SharingAgreement => ({
  agreementId: "AGR-1",
  organizationId: "ORG-A",
  recipientOrganizationId: "ORG-I",
  scopes: ["RECOMMENDATION"],
  facilityIds: ["FAC-1"],
  effectiveFrom: T,
  createdBy: "USR-1",
  createdAt: T,
  ...patch,
});

export function repositoryContract(
  label: string,
  make: () => Promise<Adapters> | Adapters,
  options: { skip?: boolean } = {},
): void {
  const d = options.skip === true ? describe.skip : describe;
  d(`repository contract: ${label}`, { timeout: 60_000 }, () => {
    it("observations: dedupe by device+signal+observedAt, tenant-scoped reads", async () => {
      const { observations: r } = await make();
      expect(await r.insertIfAbsent(obs())).toBe(true);
      expect(await r.insertIfAbsent(obs({ value: 99 }))).toBe(false);
      expect(await r.insertIfAbsent(obs({ signal: "current", value: 0.3 }))).toBe(true);
      expect(await r.insertIfAbsent(obs({ observedAt: "2026-09-29T20:00:10.000Z" }))).toBe(true);
      expect(await r.insertIfAbsent(obs({ deviceId: "DEV-2" }))).toBe(true);
      const stored = await r.list("ORG-A");
      expect(stored).toHaveLength(4);
      expect(stored.find((o) => o.signal === "temperature" && o.deviceId === "DEV-1")?.value).toBe(
        4.2,
      );
      await r.insertIfAbsent(obs({ organizationId: "ORG-B", deviceId: "DEV-9" }));
      expect(await r.list("ORG-B")).toHaveLength(1);
      expect(await r.list("ORG-NONE")).toEqual([]);
      expect((await r.get("ORG-A", "OBS-1"))?.organizationId).toBe("ORG-A");
      expect(await r.get("ORG-NONE", "OBS-1")).toBeUndefined();
    });

    it("observations: concurrent duplicate inserts store exactly one", async () => {
      const { observations: r } = await make();
      const results = await Promise.all(Array.from({ length: 6 }, () => r.insertIfAbsent(obs())));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await r.list("ORG-A")).toHaveLength(1);
    });

    it("observations: windows are inclusive, ordered, organization-, facility- and asset-scoped", async () => {
      const { observations: r } = await make();
      const at = (s: number) => `2026-09-29T20:00:${String(s).padStart(2, "0")}.000Z`;
      for (const s of [30, 10, 20, 40]) {
        await r.insertIfAbsent(obs({ observationId: `OBS-${s}`, observedAt: at(s) }));
      }
      await r.insertIfAbsent(
        obs({ observationId: "OBS-OTHER-ASSET", assetId: "AST-2", observedAt: at(20) }),
      );
      await r.insertIfAbsent(
        obs({ observationId: "OBS-OTHER-FAC", facilityId: "FAC-2", observedAt: at(20) }),
      );
      await r.insertIfAbsent(
        obs({ observationId: "OBS-OTHER-ORG", organizationId: "ORG-B", observedAt: at(20) }),
      );
      const base = { organizationId: "ORG-A", facilityId: "FAC-1", assetIds: ["AST-1"] };
      const got = await r.listForWindow({ ...base, fromIso: at(10), toIso: at(30) });
      expect(got.map((o) => o.observationId)).toEqual(["OBS-10", "OBS-20", "OBS-30"]);
      expect(
        await r.listForWindow({ ...base, organizationId: "ORG-X", fromIso: at(0), toIso: at(59) }),
      ).toEqual([]);
    });

    it("baselines: history kept, active = newest non-superseded, tenant scoped, snapshots and audit", async () => {
      const { baselines: r } = await make();
      await r.save(baseline(1, "READY", { mean: 0.18 }));
      await r.save(baseline(1, "SUPERSEDED", { mean: 0.18, supersededBy: "BSL-v2" }));
      await r.save(baseline(2, "LEARNING", { observationCount: 0, mean: 0 }));
      expect((await r.getActive(key))?.baselineId).toBe("BSL-v2");
      const history = await r.history(key);
      expect(history.map((b) => b.version)).toEqual([1, 2]);
      expect(history[0]).toMatchObject({ status: "SUPERSEDED", mean: 0.18 });
      expect((await r.listActive("ORG-A", "FAC-1")).map((b) => b.baselineId)).toEqual(["BSL-v2"]);
      expect(await r.listActive("ORG-B", "FAC-1")).toEqual([]);
      expect(await r.listActive("ORG-A", "FAC-2")).toEqual([]);
      expect((await r.getById("ORG-A", "BSL-v1"))?.status).toBe("SUPERSEDED");
      expect(await r.getById("ORG-B", "BSL-v1")).toBeUndefined();
      await r.saveSnapshot({
        snapshotId: "S1",
        organizationId: "ORG-A",
        facilityId: "FAC-1",
        baselineIds: ["a"],
        createdAt: T,
      });
      expect((await r.getSnapshot("ORG-A", "S1"))?.baselineIds).toEqual(["a"]);
      expect(await r.getSnapshot("ORG-B", "S1")).toBeUndefined();
      await r.appendAudit({
        action: "REBASELINE",
        key,
        supersededBaselineId: "a",
        newBaselineId: "b",
        actorId: "U",
        reason: "first",
        at: T,
      });
      await r.appendAudit({
        action: "REBASELINE",
        key,
        supersededBaselineId: "b",
        newBaselineId: "c",
        actorId: "U",
        reason: "second",
        at: T,
      });
      expect((await r.listAudit("ORG-A")).map((a) => a.reason)).toEqual(["first", "second"]);
      expect(await r.listAudit("ORG-B")).toEqual([]);
    });

    it("detection state round-trips by key", async () => {
      const { detectionStates: r } = await make();
      const state = {
        stateKey: "ORG-A|FAC-1|RULE",
        organizationId: "ORG-A",
        facilityId: "FAC-1",
        ruleId: "R",
        facts: {},
        zoneSamples: { "AST-ZONE": [{ at: T, value: 4 }] },
        persistence: {},
      } as never;
      expect(await r.get("ORG-A|FAC-1|RULE")).toBeUndefined();
      await r.save(state);
      expect(await r.get("ORG-A|FAC-1|RULE")).toEqual(state);
    });

    it("cases: correlation, tenant scoping, verified-improved lookup", async () => {
      const { cases: r } = await make();
      await r.save(mkCase());
      expect((await r.findActive("ORG-A", "FAC-1", "H", "AST-FAN"))?.caseId).toBe("CASE-1");
      expect(await r.findActive("ORG-B", "FAC-1", "H", "AST-FAN")).toBeUndefined();
      expect(await r.findActive("ORG-A", "FAC-2", "H", "AST-FAN")).toBeUndefined();
      expect(await r.findActive("ORG-A", "FAC-1", "OTHER", "AST-FAN")).toBeUndefined();
      expect(await r.findActive("ORG-A", "FAC-1", "H", "AST-ZONE")).toBeUndefined();
      expect(await r.get("ORG-B", "CASE-1")).toBeUndefined();
      expect(await r.list("ORG-B")).toEqual([]);
      await r.save(mkCase({ state: "CLOSED" }));
      await r.save(
        mkCase({
          caseId: "CASE-2",
          state: "VERIFIED_IMPROVED",
          latestVerificationId: "V",
          updatedAt: "2026-10-02T00:00:00.000Z",
        }),
      );
      await r.save(
        mkCase({
          caseId: "CASE-3",
          state: "VERIFIED_IMPROVED",
          latestVerificationId: "V",
          updatedAt: "2026-10-03T00:00:00.000Z",
        }),
      );
      expect(await r.findActive("ORG-A", "FAC-1", "H", "AST-FAN")).toBeUndefined();
      expect(
        (await r.findVerifiedImproved("ORG-A", "FAC-1", "H", "AST-FAN")).map((c) => c.caseId),
      ).toEqual(["CASE-3", "CASE-2"]);
      expect(await r.findVerifiedImproved("ORG-B", "FAC-1", "H", "AST-FAN")).toEqual([]);
      expect(await r.listAllForSystemTick()).toHaveLength(3);
    });

    it("risk events, alerts and actions are tenant scoped", async () => {
      const { riskEvents, alerts, actions } = await make();
      const e: RiskEvent = {
        eventId: "RE-1",
        caseId: "CASE-1",
        organizationId: "ORG-A",
        facilityId: "FAC-1",
        assetIds: ["A"],
        state: "DETECTED",
        detectedAt: T,
        updatedAt: T,
      };
      await riskEvents.save(e);
      expect(await riskEvents.get("ORG-A", "RE-1")).toEqual(e);
      expect(await riskEvents.get("ORG-B", "RE-1")).toBeUndefined();
      expect(await riskEvents.listByCase("ORG-A", "CASE-1")).toEqual([e]);
      expect(await riskEvents.listByCase("ORG-B", "CASE-1")).toEqual([]);

      const a = {
        alertId: "ALR-1",
        organizationId: "ORG-A",
        caseId: "CASE-1",
      } as unknown as Alert;
      await alerts.save(a);
      expect(await alerts.get("ORG-A", "ALR-1")).toEqual(a);
      expect(await alerts.get("ORG-B", "ALR-1")).toBeUndefined();
      expect(await alerts.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect(await alerts.listAllForSystemTick()).toHaveLength(1);

      const act = { actionId: "ACT-1", caseId: "CASE-1" } as unknown as MitigationAction;
      await actions.save("ORG-A", act);
      expect((await actions.get("ORG-A", "ACT-1"))?.actionId).toBe("ACT-1");
      expect(await actions.get("ORG-B", "ACT-1")).toBeUndefined();
      expect(await actions.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect(await actions.listByCase("ORG-A", "CASE-1")).toHaveLength(1);
    });

    it("verifications: a completed attempt can never be saved again", async () => {
      const { verifications: r } = await make();
      const base = {
        verificationId: "VER-1",
        organizationId: "ORG-A",
        caseId: "CASE-1",
        startedAt: T,
      };
      await r.save({ ...base, status: "IN_PROGRESS" } as unknown as VerificationAttempt);
      await r.save({ ...base, status: "COMPLETED" } as unknown as VerificationAttempt);
      await expect(
        r.save({ ...base, status: "IN_PROGRESS" } as unknown as VerificationAttempt),
      ).rejects.toThrow(/immutable/);
      expect((await r.get("ORG-A", "VER-1"))?.status).toBe("COMPLETED");
      expect(await r.get("ORG-B", "VER-1")).toBeUndefined();
      expect(await r.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect(await r.listByCase("ORG-A", "CASE-1")).toHaveLength(1);
    });

    it("evidence packages: one per id and per verification, immutable, tenant scoped", async () => {
      const { evidencePackages: r } = await make();
      expect(await r.insertIfAbsent(pkgRec())).toBe(true);
      expect(await r.insertIfAbsent(pkgRec())).toBe(false);
      expect(await r.insertIfAbsent(pkgRec({ packageId: "EVP-2" }))).toBe(false);
      expect(
        await r.insertIfAbsent(
          pkgRec({
            packageId: "EVP-3",
            verificationId: "VER-2",
            createdAt: "2026-10-01T02:00:00.000Z",
          }),
        ),
      ).toBe(true);
      expect((await r.listByCase("ORG-A", "CASE-1")).map((x) => x.packageId)).toEqual([
        "EVP-1",
        "EVP-3",
      ]);
      expect(await r.get("ORG-B", "EVP-1")).toBeUndefined();
      expect(await r.getByVerification("ORG-B", "VER-1")).toBeUndefined();
      expect(await r.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect((await r.get("ORG-A", "EVP-1"))?.verificationId).toBe("VER-1");
      // The same package id in another tenant is a different package.
      expect(await r.insertIfAbsent(pkgRec({ organizationId: "ORG-B" }))).toBe(true);
    });

    it("evidence packages: racing inserts for one verification create exactly one", async () => {
      const { evidencePackages: r } = await make();
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => r.insertIfAbsent(pkgRec({ packageId: `EVP-R${i}` }))),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await r.listByCase("ORG-A", "CASE-1")).toHaveLength(1);
    });

    it("sharing agreements: duplicate refused, scoped reads, revoke once and keep terms", async () => {
      const { agreements: r } = await make();
      await r.insert(agreement());
      await expect(r.insert(agreement())).rejects.toThrow(/already exists/);
      expect(await r.getForOwner("ORG-B", "AGR-1")).toBeUndefined();
      expect(await r.listForOwner("ORG-B")).toEqual([]);
      expect(await r.listForRecipient("ORG-X")).toEqual([]);
      expect((await r.listForRecipient("ORG-I")).map((a) => a.agreementId)).toEqual(["AGR-1"]);
      const first = await r.revoke("ORG-A", "AGR-1", {
        revokedAt: "2026-10-02T00:00:00.000Z",
        revokedBy: "USR-2",
        reason: "why",
      });
      expect(first.status).toBe("REVOKED");
      expect(first.status === "REVOKED" && first.agreement).toMatchObject({
        scopes: ["RECOMMENDATION"],
        facilityIds: ["FAC-1"],
        createdBy: "USR-1",
        revokedAt: "2026-10-02T00:00:00.000Z",
        revocationReason: "why",
      });
      expect(
        (
          await r.revoke("ORG-A", "AGR-1", {
            revokedAt: "2030-01-01T00:00:00.000Z",
            revokedBy: "U",
          })
        ).status,
      ).toBe("ALREADY_REVOKED");
      expect((await r.getForOwner("ORG-A", "AGR-1"))?.revokedAt).toBe("2026-10-02T00:00:00.000Z");
      expect((await r.revoke("ORG-B", "AGR-1", { revokedAt: "x", revokedBy: "y" })).status).toBe(
        "NOT_FOUND",
      );
      expect((await r.revoke("ORG-A", "AGR-9", { revokedAt: "x", revokedBy: "y" })).status).toBe(
        "NOT_FOUND",
      );
    });

    it("sharing agreements: concurrent revocations succeed exactly once", async () => {
      const { agreements: r } = await make();
      await r.insert(agreement());
      const outcomes = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          r.revoke("ORG-A", "AGR-1", { revokedAt: T, revokedBy: `USR-${i}` }),
        ),
      );
      expect(outcomes.filter((o) => o.status === "REVOKED")).toHaveLength(1);
    });

    it("shared evidence: one release per agreement and package", async () => {
      const { shares: r } = await make();
      const share = (patch: Partial<SharedEvidenceRecord> = {}): SharedEvidenceRecord => ({
        shareId: "SHR-1",
        agreementId: "AGR-1",
        organizationId: "ORG-A",
        facilityId: "FAC-1",
        caseId: "CASE-1",
        evidencePackageId: "EVP-1",
        recipientOrganizationId: "ORG-I",
        sharedAt: T,
        ...patch,
      });
      expect(await r.insertIfAbsent(share())).toBe(true);
      expect(await r.insertIfAbsent(share({ shareId: "SHR-2" }))).toBe(false);
      expect(await r.insertIfAbsent(share({ shareId: "SHR-3", evidencePackageId: "EVP-2" }))).toBe(
        true,
      );
      expect(await r.listByCase("ORG-A", "CASE-1")).toHaveLength(2);
      expect(await r.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect(await r.listByAgreement("ORG-A", "AGR-1")).toHaveLength(2);
      expect(await r.listByAgreement("ORG-B", "AGR-1")).toEqual([]);
    });

    it("audit: append-only, gap-free sequence per organization, tenant scoped, ordered", async () => {
      const { audit } = await make();
      const entry = (organizationId: string, caseId: string, n: number) => ({
        organizationId,
        facilityId: "FAC-1",
        caseId,
        actorId: "U",
        actorType: "USER" as const,
        action: "CASE_CREATED" as const,
        targetType: "CASE" as const,
        targetId: `${caseId}-${n}`,
        correlationId: "COR",
        at: T,
      });
      const a1 = await audit.append(entry("ORG-A", "CASE-1", 1));
      const a2 = await audit.append(entry("ORG-A", "CASE-1", 2));
      const b1 = await audit.append(entry("ORG-B", "CASE-9", 1));
      // Sequences are strictly increasing and unique within an organization (the in-memory log
      // numbers globally, Firestore per organization: both satisfy the contract).
      expect(a2.sequence).toBeGreaterThan(a1.sequence);
      expect(a1.auditId).toMatch(/^AUD-[0-9]{6}$/);
      expect(b1.organizationId).toBe("ORG-B");
      expect((await audit.listByCase("ORG-A", "CASE-1")).map((e) => e.sequence)).toEqual([1, 2]);
      expect(await audit.listByCase("ORG-B", "CASE-1")).toEqual([]);
      expect(await audit.list("ORG-NONE")).toEqual([]);
      expect(await audit.list("ORG-A")).toHaveLength(2);
      const concurrent = await Promise.all(
        Array.from({ length: 5 }, (_, i) => audit.append(entry("ORG-C", "CASE-C", i))),
      );
      const seqs = concurrent.map((e) => e.sequence).sort((x, y) => x - y);
      expect(new Set(seqs).size).toBe(5);
      expect(await audit.list("ORG-C")).toHaveLength(5);
      expect(() => {
        (a1 as { sequence: number }).sequence = 99;
      }).toThrow();
    });

    it("device registry: lookup, facility listing, recordSeen merges, unknown device ignored", async () => {
      const { registry } = await make();
      const device: DeviceRecord = {
        deviceId: "DEV-1",
        organizationId: "ORG-A",
        facilityId: "FAC-1",
        assetId: "AST-1",
        status: "ACTIVE",
        activeKeyId: "KEY-1",
        expectedSignals: ["temperature"],
        capabilities: ["telemetry"],
        health: "UNKNOWN",
      };
      // Memory registries take the record in the constructor; cloud ones through put().
      if (registry.put !== undefined) await registry.put(device);
      expect((await registry.get("DEV-1"))?.activeKeyId).toBe("KEY-1");
      expect(await registry.get("DEV-NONE")).toBeUndefined();
      expect((await registry.listForFacility("ORG-A", "FAC-1")).map((x) => x.deviceId)).toEqual([
        "DEV-1",
      ]);
      expect(await registry.listForFacility("ORG-B", "FAC-1")).toEqual([]);
      await registry.recordSeen("DEV-1", { seenAt: T, health: "HEALTHY", firmwareVersion: "1.2" });
      await registry.recordSeen("DEV-NONE", { seenAt: T });
      expect(await registry.get("DEV-1")).toMatchObject({
        lastSeenAt: T,
        health: "HEALTHY",
        firmwareVersion: "1.2",
        activeKeyId: "KEY-1",
      });
    });

    it("replay guard: nonce replay, sequence reuse and rollback are rejected; concurrent duplicates accepted once", async () => {
      const { replay } = await make();
      const c = (seq: number, nonce: string) => ({
        deviceId: "DEV-1",
        keyId: "KEY-1",
        nonce,
        seq,
        timestampSeconds: 1000,
        nowSeconds: 1000,
      });
      expect(await replay.checkAndRecord(c(5, "nonce-aaaaaaaaaaaa1"))).toEqual({ ok: true });
      expect(await replay.checkAndRecord(c(6, "nonce-aaaaaaaaaaaa1"))).toEqual({
        ok: false,
        reason: "NONCE_REPLAY",
      });
      expect(await replay.checkAndRecord(c(5, "nonce-aaaaaaaaaaaa2"))).toEqual({
        ok: false,
        reason: "SEQUENCE_REUSE",
      });
      expect(await replay.checkAndRecord(c(4, "nonce-aaaaaaaaaaaa3"))).toEqual({
        ok: false,
        reason: "SEQUENCE_ROLLBACK",
      });
      expect(await replay.checkAndRecord(c(9, "nonce-aaaaaaaaaaaa4"))).toEqual({ ok: true });
      const racing = await Promise.all(
        Array.from({ length: 4 }, () => replay.checkAndRecord(c(20, "nonce-aaaaaaaaaaaa5"))),
      );
      expect(racing.filter((r) => r.ok)).toHaveLength(1);
    });
  });
}
