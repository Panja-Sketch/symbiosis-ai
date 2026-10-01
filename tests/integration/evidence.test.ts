import { afterEach, describe, expect, it } from "vitest";
import type {
  EvidencePackage,
  VerificationAttempt,
  VerificationAssessment,
} from "@symbiosis/contracts";
import { ManualClock } from "@symbiosis/clock";
import { SequentialIdGenerator, InMemoryBus } from "@symbiosis/event-bus";
import {
  InMemoryEvidenceObjectStore,
  buildEvidencePackage,
  canonicalJson,
  createEvidenceService,
  sha256OfCanonical,
  verifyEvidencePackage,
} from "@symbiosis/evidence";
import type { BuildEvidenceInput } from "@symbiosis/evidence";
import { InMemoryEvidencePackageRepository } from "@symbiosis/repositories";
import type { VerificationRepository } from "@symbiosis/repositories";
import { FAC, MGR, ORG, closeAll, makeWorld } from "./s6-world";
import type { Json, World } from "./s6-world";

afterEach(closeAll);

const clone = <T>(v: T): T => structuredClone(v);

async function loadPackage(w: World, packageId: string): Promise<EvidencePackage> {
  const r = await w.api("GET", `/api/v1/evidence/${packageId}`, MGR);
  expect(r.status).toBe(200);
  return r.body.package as EvidencePackage;
}

/** Reads the trusted records a package is built from, exactly as the evidence service does. */
async function inputFor(w: World, caseId: string): Promise<BuildEvidenceInput> {
  const rt = w.runtime;
  const attempt = (await rt.verifications.listByCase(ORG, caseId)).at(-1) as VerificationAttempt;
  const caseRecord = await rt.cases.get(ORG, caseId);
  const event = await rt.riskEvents.get(ORG, attempt.eventId);
  const refs = attempt.evidenceReferences ?? [];
  const observations = [];
  for (const r of refs.filter((x) => x.kind === "OBSERVATION")) {
    const o = await rt.observations.get(ORG, r.id);
    if (o !== undefined) observations.push(o);
  }
  const baselines = [];
  for (const r of refs.filter((x) => x.kind === "BASELINE")) {
    const b = await rt.baselines.getById(ORG, r.id);
    if (b !== undefined) baselines.push(b);
  }
  return {
    packageId: "EVP-TEST",
    createdAt: new Date(w.clock.nowMs()).toISOString(),
    caseRecord: caseRecord as NonNullable<typeof caseRecord>,
    event: event as NonNullable<typeof event>,
    attempt,
    priorAttempts: [],
    actions: await rt.actions.listByCase(ORG, caseId),
    observations,
    baselines,
    auditEntries: await rt.audit.listByCase(ORG, caseId),
    policies: [
      {
        policyId: rt.verificationPolicy.policyId,
        policyVersion: rt.verificationPolicy.policyVersion,
        document: rt.verificationPolicy,
      },
    ],
    approvedActions: [],
  };
}

describe("E1 a completed VERIFIED verification produces one immutable evidence package", () => {
  it("creates the package, links it to the case and emits the events in order", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    const records = await w.runtime.evidencePackages.listByCase(ORG, caseId);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({
      verificationId: attempt.verificationId,
      result: "VERIFIED",
      schemaVersion: "evidence-package.v1",
    });
    expect(record?.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.manifestSha256).toMatch(/^[0-9a-f]{64}$/);

    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c).toMatchObject({
      state: "VERIFIED_IMPROVED",
      latestEvidencePackageId: record?.packageId,
      latestVerificationId: attempt.verificationId,
      sharingState: "SHAREABLE",
    });

    const hist = w.runtime.bus.history();
    const completed = hist.find((e) => e.event_type === "verification.completed.v1");
    const created = hist.find((e) => e.event_type === "evidence.package_created.v1");
    const shareable = hist.find((e) => e.event_type === "evidence.shareable.v1");
    expect(created?.causation_id).toBe(completed?.event_id);
    expect(created?.correlation_id).toBe(completed?.correlation_id);
    expect(shareable?.causation_id).toBe(created?.event_id);
    expect(created?.payload).toMatchObject({
      evidencePackageId: record?.packageId,
      result: "VERIFIED",
      verificationId: attempt.verificationId,
      dataOrigin: "SYNTHETIC_SIMULATOR",
      payloadSha256: record?.payloadSha256,
    });
    expect(shareable?.payload).toMatchObject({
      previousSharingState: "NOT_SHARED",
      sharingState: "SHAREABLE",
    });
    const order = hist.map((e) => e.event_type as string);
    expect(order.indexOf("verification.completed.v1")).toBeLessThan(
      order.indexOf("evidence.package_created.v1"),
    );
    expect(order.indexOf("evidence.package_created.v1")).toBeLessThan(
      order.indexOf("evidence.shareable.v1"),
    );
    expect(order).not.toContain("evidence.shared.v1");
    expect(order).not.toContain("consent.granted.v1");
    expect(w.runtime.bus.deadLetters()).toEqual([]);

    const audit = (await w.runtime.audit.listByCase(ORG, caseId)).filter(
      (e) => e.action === "EVIDENCE_PACKAGE_CREATED",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: "SYSTEM",
      targetType: "EVIDENCE_PACKAGE",
      targetId: record?.packageId,
      correlationId: completed?.correlation_id,
    });
  });

  it("contains every item the specification lists, from existing trusted records", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const record = await w.latestPackage(caseId);
    const pkg = await loadPackage(w, record?.packageId ?? "");
    const p = pkg.payload;
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    const a = attempt.assessment as VerificationAssessment;

    expect(p.caseIdentity).toMatchObject({ caseId, organizationId: ORG, facilityId: FAC });
    expect(p.recommendation).toMatchObject({ source: "SYMBIOSIS", recommendationId: null });
    expect(p.recommendation.origin.type).toBe("DETECTED_HAZARD");
    expect(p.riskEvent).toMatchObject({ eventId: attempt.eventId });
    expect(p.riskEvent.detectionReasonCodes.length).toBeGreaterThan(0);
    expect(p.reportedActions).toHaveLength(1);
    expect(p.reportedActions[0]).toMatchObject({
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      status: "REPORTED_COMPLETE",
    });
    expect(p.acknowledgement).toMatchObject({ acknowledgedBy: MGR });
    expect(p.baselineWindow).toEqual(a.baselineWindow);
    expect(p.postActionWindow).toEqual(a.postActionWindow);
    expect(p.requiredCriteria).toEqual(JSON.parse(JSON.stringify(a.requiredCriteria)));
    expect(p.supportingCriteria).toEqual(JSON.parse(JSON.stringify(a.supportingCriteria)));
    expect(p.quality).toEqual({
      dataCompleteness: a.dataCompleteness,
      telemetryConfidence: a.telemetryConfidence,
      deviceHealthStatus: a.deviceHealthStatus,
      authIntegrityStatus: a.authIntegrityStatus,
    });
    expect(p.verification).toMatchObject({
      result: "VERIFIED",
      confidence: a.confidence,
      policyId: "VPOL-COOLING-ELECTRICAL",
      policyVersion: "1",
      evaluatedAt: a.evaluatedAt,
    });
    expect(p.recurrence).toMatchObject({ recurrenceCount: 0 });
    expect(p.recurrence.recurrenceWatchEndsAt).toBe(attempt.recurrenceWatchEndsAt);
    expect(p.versions).toMatchObject({
      verificationPolicy: { id: "VPOL-COOLING-ELECTRICAL", version: "1" },
      evidenceSchema: "evidence-package.v1",
      hashAlgorithm: "SHA-256",
      canonicalization: "symbiosis-canonical-json.v1",
    });
    expect(p.source).toMatchObject({
      dataOrigin: "SYNTHETIC_SIMULATOR",
      synthetic: true,
      sourceTypes: ["SIMULATOR"],
    });
    expect(p.source.label).toMatch(/^SYNTHETIC DATA/);
    expect(p.auditReferences.length).toBeGreaterThan(5);
    // every verification evidence reference is an artifact with a hash, nothing more, nothing less
    expect(pkg.artifacts.map((x) => `${x.kind}|${x.id}`).sort()).toEqual(
      (attempt.evidenceReferences ?? []).map((r) => `${r.kind}|${r.id}`).sort(),
    );
    expect(p.evidenceReferences).toHaveLength(pkg.artifacts.length);
    expect(pkg.manifest.artifactCount).toBe(pkg.artifacts.length);
    expect(p.evidenceReferences.every((d) => /^[0-9a-f]{64}$/.test(d.sha256))).toBe(true);
    // the package leaks no key material and nothing is invented: no timestamp/id in the payload
    const text = JSON.stringify(pkg);
    expect(text).not.toContain("0123456789abcdef0123456789abcdef");
    expect(text).not.toContain("KEY-SIM-001");
    expect(Object.keys(p)).not.toContain("createdAt");
    expect(Object.keys(p)).not.toContain("packageId");
  });

  it("is deterministic: identical trusted history gives byte-identical package hashes", async () => {
    const run = async () => {
      const w = await makeWorld();
      const caseId = await w.verified();
      const r = await w.latestPackage(caseId);
      await closeAll();
      return r;
    };
    const a = await run();
    const b = await run();
    expect(a?.payloadSha256).toBe(b?.payloadSha256);
    expect(a?.manifestSha256).toBe(b?.manifestSha256);
    expect(a?.byteLength).toBe(b?.byteLength);
  });

  it("is idempotent: redelivery or a second request creates no second package or event", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    const again = await w.runtime.evidenceService.createForVerification(
      ORG,
      attempt.verificationId,
    );
    expect(again.ok && again.value.created).toBe(false);
    expect(await w.runtime.evidencePackages.listByCase(ORG, caseId)).toHaveLength(1);
    expect(w.types().filter((t) => t === "evidence.package_created.v1")).toHaveLength(1);
    expect((await w.runtime.tick()).evidence.created).toEqual([]);
  });

  it("does not create or change anything in the physical-risk record", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const attempt = (await w.runtime.verifications.listByCase(ORG, caseId))[0];
    const c = await w.runtime.cases.get(ORG, caseId);
    const event = await w.runtime.riskEvents.get(ORG, attempt?.eventId ?? "");
    // everything except the two documentation fields equals what verification left behind
    expect(c).toMatchObject({
      state: "VERIFIED_IMPROVED",
      severity: "MODERATE",
      recurrenceCount: 0,
      latestVerificationId: attempt?.verificationId,
    });
    expect(event?.state).toBe("VERIFIED");
    const stored = (await w.runtime.verifications.get(
      ORG,
      attempt?.verificationId ?? "",
    )) as VerificationAttempt;
    expect(stored.status).toBe("COMPLETED");
    expect(stored.assessment?.result).toBe("VERIFIED");
    expect(JSON.stringify(stored)).toBe(JSON.stringify(attempt));
    // the case's own updatedAt is the verification time, not the documentation time
    expect(c?.updatedAt).toBe(event?.updatedAt);
  });
});

describe("E2 the package represents what was known at verification time", () => {
  it("freezes device health/auth facts: later registry changes do not rewrite the package", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const record = await w.latestPackage(caseId);
    const before = await loadPackage(w, record?.packageId ?? "");
    const device = before.artifacts.find((a) => a.kind === "DEVICE");
    expect(device?.snapshot).toMatchObject({
      deviceId: "DEV-SIM-001",
      status: "ACTIVE",
      health: "HEALTHY",
      organizationId: ORG,
    });
    expect(before.payload.quality.deviceHealthStatus).toBe("HEALTHY");

    await w.client.sendHeartbeat("FAULT"); // the live registry now says FAULT
    expect((await w.runtime.registry.get("DEV-SIM-001"))?.health).toBe("FAULT");

    const after = await loadPackage(w, record?.packageId ?? "");
    expect(after).toEqual(before);
    expect(verifyEvidencePackage(after).valid).toBe(true);
    // the S5 resolver also uses the frozen copy, not the live record
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    expect(attempt.deviceSnapshots?.[0]).toMatchObject({
      health: "HEALTHY",
      deviceId: "DEV-SIM-001",
    });
    const resolved = await w.runtime.resolveEvidence(attempt.verificationId, ORG);
    expect(resolved.every((r) => r.exists)).toBe(true);
    expect(resolved.some((r) => r.kind === "DEVICE")).toBe(true);
  });

  it("a mutable record that changes later (case, event, device) never alters an existing package", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const record = await w.latestPackage(caseId);
    const before = await loadPackage(w, record?.packageId ?? "");
    expect(before.payload.caseIdentity.state).toBe("VERIFIED_IMPROVED");
    expect(before.payload.riskEvent.state).toBe("VERIFIED");
    // recurrence reopens the case and starts a new event
    await w.send("normal", 12);
    await w.send("compound-outdoor-heat", 3);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("REOPENED");
    const after = await loadPackage(w, record?.packageId ?? "");
    expect(after).toEqual(before);
    expect(after.payload.caseIdentity.state).toBe("VERIFIED_IMPROVED");
  });

  it("an attempt without a device snapshot cannot yield a package that cites a device", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const input = await inputFor(w, caseId);
    const stripped = { ...input.attempt } as { deviceSnapshots?: unknown };
    delete stripped.deviceSnapshots;
    const r = buildEvidencePackage({ ...input, attempt: stripped as VerificationAttempt });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNRESOLVED_EVIDENCE");
      expect(r.error.details).toContain("DEVICE:DEVICE:DEV-SIM-001");
    }
  });
});

describe("E3 hashes, manifest and tamper detection", () => {
  async function pkgOf(w: World) {
    const caseId = await w.verified();
    const record = await w.latestPackage(caseId);
    return { caseId, record, pkg: await loadPackage(w, record?.packageId ?? "") };
  }

  it("an unchanged package verifies, and the manifest binds payload, artifacts, versions and identity", async () => {
    const w = await makeWorld();
    const { pkg, record } = await pkgOf(w);
    expect(verifyEvidencePackage(pkg)).toMatchObject({
      valid: true,
      issues: [],
      payloadSha256: pkg.manifest.payloadSha256,
      manifestSha256: pkg.manifestSha256,
    });
    expect(pkg.manifest).toMatchObject({
      manifestSchema: "evidence-manifest.v1",
      hashAlgorithm: "SHA-256",
      canonicalization: "symbiosis-canonical-json.v1",
      packageId: record?.packageId,
      verificationId: pkg.verificationId,
      versions: { verificationPolicy: { id: "VPOL-COOLING-ELECTRICAL", version: "1" } },
    });
    expect(pkg.manifest.createdAt).toBe(pkg.createdAt);
    expect(sha256OfCanonical(pkg.payload)).toBe(pkg.manifest.payloadSha256);
    expect(sha256OfCanonical(pkg.manifest)).toBe(pkg.manifestSha256);
    for (const a of pkg.artifacts) expect(sha256OfCanonical(a.snapshot)).toBe(a.sha256);
    // artifacts are sorted by kind then id, so the manifest is order-stable
    const keys = pkg.manifest.artifacts.map((a) => `${a.kind}|${a.id}`);
    expect(keys).toHaveLength(new Set(keys).size);
  });

  it("changing one value of the payload fails verification", async () => {
    const w = await makeWorld();
    const { pkg } = await pkgOf(w);
    const t = clone(pkg) as unknown as { payload: { verification: { confidence: number } } };
    t.payload.verification.confidence += 0.0001;
    const r = verifyEvidencePackage(t as unknown as EvidencePackage);
    expect(r.valid).toBe(false);
    expect(r.issues).toContain("PAYLOAD_HASH_MISMATCH");
  });

  it("changing the verification result text (VERIFIED -> NOT_IMPROVING) fails verification", async () => {
    const w = await makeWorld();
    const { pkg } = await pkgOf(w);
    const t = clone(pkg) as unknown as { payload: { verification: { result: string } } };
    t.payload.verification.result = "NOT_IMPROVING";
    expect(verifyEvidencePackage(t as unknown as EvidencePackage).valid).toBe(false);
  });

  it("a one-character change in an artifact snapshot, or in an artifact hash, fails verification", async () => {
    const w = await makeWorld();
    const { pkg } = await pkgOf(w);
    const t1 = clone(pkg) as unknown as { artifacts: { snapshot: Json }[] };
    const obs = t1.artifacts.find((a) => (a.snapshot as Json).signal !== undefined);
    (obs?.snapshot as Json).value = Number((obs?.snapshot as Json).value) + 1;
    const r1 = verifyEvidencePackage(t1 as unknown as EvidencePackage);
    expect(r1.valid).toBe(false);
    expect(r1.issues.some((i) => i.startsWith("ARTIFACT_HASH_MISMATCH"))).toBe(true);

    const t2 = clone(pkg) as unknown as { artifacts: { sha256: string }[] };
    const first = t2.artifacts[0] as { sha256: string };
    first.sha256 = (first.sha256.startsWith("0") ? "1" : "0") + first.sha256.slice(1);
    const r2 = verifyEvidencePackage(t2 as unknown as EvidencePackage);
    expect(r2.valid).toBe(false);
    expect(r2.issues).toContain("MANIFEST_ARTIFACTS_MISMATCH");
  });

  it("a changed referenced-artifact hash in the manifest or payload fails verification", async () => {
    const w = await makeWorld();
    const { pkg } = await pkgOf(w);
    const t = clone(pkg) as unknown as {
      manifest: { artifacts: { sha256: string }[] };
      payload: { evidenceReferences: { sha256: string }[] };
    };
    (t.manifest.artifacts[3] as { sha256: string }).sha256 = "f".repeat(64);
    const r = verifyEvidencePackage(t as unknown as EvidencePackage);
    expect(r.valid).toBe(false);
    expect(r.issues).toContain("MANIFEST_ARTIFACTS_MISMATCH");
    expect(r.issues).toContain("MANIFEST_HASH_MISMATCH");

    const u = clone(pkg) as unknown as typeof t;
    (u.payload.evidenceReferences[0] as { sha256: string }).sha256 = "e".repeat(64);
    const r2 = verifyEvidencePackage(u as unknown as EvidencePackage);
    expect(r2.valid).toBe(false);
    expect(r2.issues).toContain("PAYLOAD_REFERENCES_MISMATCH");
  });

  it("dropping an artifact, changing the manifest or the package id fails verification", async () => {
    const w = await makeWorld();
    const { pkg } = await pkgOf(w);
    const dropped = clone(pkg) as unknown as { artifacts: unknown[] };
    dropped.artifacts.pop();
    expect(verifyEvidencePackage(dropped as unknown as EvidencePackage).valid).toBe(false);
    const m = clone(pkg) as unknown as { manifest: { createdAt: string } };
    m.manifest.createdAt = "2030-01-01T00:00:00.000Z";
    expect(verifyEvidencePackage(m as unknown as EvidencePackage).valid).toBe(false);
    const id = clone(pkg) as unknown as { packageId: string };
    id.packageId = "EVP-OTHER";
    expect(verifyEvidencePackage(id as unknown as EvidencePackage).issues).toContain(
      "IDENTITY_MISMATCH:PACKAGE_ID",
    );
    const junk = verifyEvidencePackage({} as EvidencePackage);
    expect(junk.valid).toBe(false); // never throws on garbage
  });

  it("a historical package stays verifiable after every live source record has changed", async () => {
    const w = await makeWorld();
    const { pkg, caseId } = await pkgOf(w);
    await w.send("normal", 12);
    await w.send("compound-outdoor-heat", 3); // recurrence reopens the case
    await w.client.sendHeartbeat("FAULT");
    expect((await w.runtime.registry.get("DEV-SIM-001"))?.health).toBe("FAULT");
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("REOPENED");
    expect(verifyEvidencePackage(pkg).valid).toBe(true);
    const again = await loadPackage(w, pkg.packageId);
    expect(again).toEqual(pkg);
  });

  it("a self-consistent forgery (all hashes recomputed) is still caught by the stored index", async () => {
    const store = new InMemoryEvidenceObjectStore();
    const w = await makeWorld({ evidenceStore: store });
    const { pkg, record } = await pkgOf(w);
    const forged = clone(pkg) as unknown as {
      payload: { verification: { result: string } };
      manifest: { payloadSha256: string };
      manifestSha256: string;
    };
    forged.payload.verification.result = "INCONCLUSIVE";
    forged.manifest.payloadSha256 = sha256OfCanonical(forged.payload);
    forged.manifestSha256 = sha256OfCanonical(forged.manifest);
    expect(verifyEvidencePackage(forged as unknown as EvidencePackage).valid).toBe(true); // alone, it is consistent
    store.tamperForTest(record?.objectKey ?? "", canonicalJson(forged));
    const loaded = await w.runtime.evidenceService.load(ORG, pkg.packageId);
    expect(loaded.ok && loaded.value.integrity.valid).toBe(false);
    expect(loaded.ok && loaded.value.integrity.issues).toContain("INDEX_MISMATCH:MANIFEST_HASH");
    const api = await w.api("GET", `/api/v1/evidence/${pkg.packageId}`, MGR);
    expect(api.body.integrity.valid).toBe(false);
  });

  it("stored bytes that were altered, or removed, are reported and never served as valid", async () => {
    const store = new InMemoryEvidenceObjectStore();
    const w = await makeWorld({ evidenceStore: store });
    const { pkg, record } = await pkgOf(w);
    const text = (await store.get(record?.objectKey ?? "")) as string;
    store.tamperForTest(record?.objectKey ?? "", text.replace("VERIFIED", "NOT_IMPROVING"));
    const loaded = await w.runtime.evidenceService.load(ORG, pkg.packageId);
    expect(loaded.ok && loaded.value.integrity.valid).toBe(false);
    store.tamperForTest(record?.objectKey ?? "", "not json");
    const broken = await w.runtime.evidenceService.load(ORG, pkg.packageId);
    expect(!broken.ok && broken.error.code).toBe("INTEGRITY_FAILURE");
  });

  it("the package is immutable: the store and the index refuse an overwrite", async () => {
    const store = new InMemoryEvidenceObjectStore();
    const w = await makeWorld({ evidenceStore: store });
    const { record } = await pkgOf(w);
    expect(await store.putIfAbsent(record?.objectKey ?? "", "x")).toBe(false);
    expect(
      await w.runtime.evidencePackages.insertIfAbsent({
        ...(record as NonNullable<typeof record>),
      }),
    ).toBe(false);
    expect(
      await w.runtime.evidencePackages.insertIfAbsent({
        ...(record as NonNullable<typeof record>),
        packageId: "EVP-SECOND",
      }),
    ).toBe(false); // one package per verification
  });
});

describe("E4 package creation cannot invent facts and fails explicitly", () => {
  it("a verification whose evidence id does not resolve yields no package", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    const forged: VerificationAttempt = {
      ...attempt,
      evidenceReferences: [
        ...(attempt.evidenceReferences ?? []),
        { id: "OBS-DOES-NOT-EXIST", kind: "OBSERVATION" },
      ],
      assessment: {
        ...(attempt.assessment as VerificationAssessment),
        evidenceIds: [...(attempt.assessment?.evidenceIds ?? []), "OBS-DOES-NOT-EXIST"],
      },
    };
    const verifications = {
      get: async (_o: string, id: string) => (id === attempt.verificationId ? forged : undefined),
      listByCase: async () => [forged],
      listAllForSystemTick: async () => [forged],
      save: async () => {
        throw new Error("read-only");
      },
    } as unknown as VerificationRepository;
    const bus = new InMemoryBus();
    const packages = new InMemoryEvidencePackageRepository();
    const rt = w.runtime;
    const svc = createEvidenceService({
      bus,
      ids: new SequentialIdGenerator(),
      clock: new ManualClock(w.clock.nowMs()),
      audit: rt.audit,
      cases: rt.cases,
      riskEvents: rt.riskEvents,
      actions: rt.actions,
      observations: rt.observations,
      baselines: rt.baselines,
      verifications,
      packages,
      store: new InMemoryEvidenceObjectStore(),
      policies: [
        {
          policyId: rt.verificationPolicy.policyId,
          policyVersion: rt.verificationPolicy.policyVersion,
          document: rt.verificationPolicy,
        },
      ],
      approvedActionsFor: () => [],
    });
    const r = await svc.createForVerification(ORG, attempt.verificationId);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("UNRESOLVED_EVIDENCE");
      expect(r.error.details).toContain("OBSERVATION:OBS-DOES-NOT-EXIST");
    }
    expect(await packages.listByCase(ORG, caseId)).toEqual([]);
    expect(bus.history()).toEqual([]);
  });

  it("the builder fails on a missing observation, baseline, action, audit entry, policy or device", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const base = await inputFor(w, caseId);
    expect(buildEvidencePackage(base).ok).toBe(true);
    const failing = (patch: Partial<BuildEvidenceInput>) =>
      buildEvidencePackage({ ...base, ...patch });
    const expectUnresolved = (r: ReturnType<typeof failing>, kindPrefix: string) => {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("UNRESOLVED_EVIDENCE");
        expect((r.error.details ?? []).some((d) => d.startsWith(kindPrefix))).toBe(true);
      }
    };
    expectUnresolved(failing({ observations: base.observations.slice(1) }), "OBSERVATION:");
    expectUnresolved(failing({ baselines: [] }), "BASELINE:");
    expectUnresolved(
      failing({ auditEntries: base.auditEntries.filter((e) => e.action !== "ACTION_REPORTED") }),
      "AUDIT:",
    );
    expectUnresolved(failing({ policies: [] }), "POLICY:");
    const noCompletion = failing({
      auditEntries: base.auditEntries.filter((e) => e.action !== "VERIFICATION_COMPLETED"),
    });
    expect(noCompletion.ok).toBe(false);
    const noActions = failing({ actions: [] });
    expect(noActions.ok).toBe(false);
  });

  it("refuses a verification that is not completed, or sources that belong together incorrectly", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const base = await inputFor(w, caseId);
    const inProgress = buildEvidencePackage({
      ...base,
      attempt: { ...base.attempt, status: "IN_PROGRESS" },
    });
    expect(!inProgress.ok && inProgress.error.code).toBe("VERIFICATION_NOT_COMPLETED");
    const noAssessment = buildEvidencePackage({
      ...base,
      attempt: { ...base.attempt, assessment: undefined } as unknown as VerificationAttempt,
    });
    expect(!noAssessment.ok && noAssessment.error.code).toBe("VERIFICATION_NOT_COMPLETED");
    const otherCase = buildEvidencePackage({
      ...base,
      caseRecord: { ...base.caseRecord, caseId: "CASE-OTHER" },
    });
    expect(!otherCase.ok && otherCase.error.code).toBe("INCONSISTENT_SOURCE");
    const orphan = buildEvidencePackage({
      ...base,
      attempt: {
        ...base.attempt,
        assessment: {
          ...(base.attempt.assessment as VerificationAssessment),
          evidenceIds: [...(base.attempt.assessment?.evidenceIds ?? []), "NOT-REFERENCED"],
        },
      },
    });
    expect(!orphan.ok && orphan.error.code).toBe("UNRESOLVED_EVIDENCE");
    // no package exists while verification is still pending
    const pendingW = await makeWorld();
    const pendingCase = await pendingW.detect();
    await pendingW.reportAction(pendingCase);
    await pendingW.runtime.tick(); // verification started, window open
    expect(await pendingW.runtime.evidencePackages.listByCase(ORG, pendingCase)).toEqual([]);
    expect(pendingW.types().some((t) => t.startsWith("evidence."))).toBe(false);
    const open = (await pendingW.runtime.verifications.listByCase(ORG, pendingCase))[0];
    const direct = await pendingW.runtime.evidenceService.createForVerification(
      ORG,
      open?.verificationId ?? "",
    );
    expect(!direct.ok && direct.error.code).toBe("VERIFICATION_NOT_COMPLETED");
  });

  it("a missing acknowledgement is recorded as absent, never made up", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const base = await inputFor(w, caseId);
    const r = buildEvidencePackage({
      ...base,
      auditEntries: base.auditEntries.filter((e) => e.action !== "RISK_ACKNOWLEDGED"),
    });
    expect(r.ok && r.value.payload.acknowledgement).toBeNull();
  });

  it("a storage failure is explicit: no package, no case link, no event, dead-lettered, and the tick recovers", async () => {
    class FlakyStore extends InMemoryEvidenceObjectStore {
      failing = true;
      override async putIfAbsent(key: string, content: string): Promise<boolean> {
        if (this.failing) throw new Error("disk full");
        return super.putIfAbsent(key, content);
      }
    }
    const store = new FlakyStore();
    const w = await makeWorld({ evidenceStore: store });
    const caseId = await w.verified();
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c?.state).toBe("VERIFIED_IMPROVED"); // the verification itself is unaffected
    expect(c?.latestEvidencePackageId).toBeUndefined();
    expect(c?.sharingState).toBe("NOT_SHARED");
    expect(await w.runtime.evidencePackages.listByCase(ORG, caseId)).toEqual([]);
    expect(w.types()).not.toContain("evidence.package_created.v1");
    const dead = w.runtime.bus.deadLetters();
    expect(dead).toHaveLength(1);
    expect(String((dead[0]?.error as Error).message)).toContain("STORAGE_FAILURE");

    const stillFailing = await w.runtime.tick();
    expect(stillFailing.evidence.failures).toHaveLength(1);
    store.failing = false;
    const recovered = await w.runtime.tick();
    expect(recovered.evidence.created).toHaveLength(1);
    expect((await w.runtime.cases.get(ORG, caseId))?.sharingState).toBe("SHAREABLE");
    expect(w.types().filter((t) => t === "evidence.package_created.v1")).toHaveLength(1);
  });
});

describe("E5 a package preserves its actual result", () => {
  it("INCONCLUSIVE: no post-action telemetry", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    w.clock.advance(200_000);
    await w.runtime.tick();
    const rec = await w.latestPackage(caseId);
    expect(rec?.result).toBe("INCONCLUSIVE");
    const pkg = await loadPackage(w, rec?.packageId ?? "");
    expect(pkg.payload.verification.result).toBe("INCONCLUSIVE");
    expect(pkg.payload.quality.dataCompleteness).toBe(0);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("INCONCLUSIVE");
    expect(JSON.stringify(pkg.payload.verification)).not.toMatch(/VERIFIED/);
    expect(verifyEvidencePackage(pkg).valid).toBe(true);
    expect(w.types()).toContain("evidence.shareable.v1"); // history is shareable, truthfully
  });

  it("NOT_IMPROVING: the condition persists", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick();
    const rec = await w.latestPackage(caseId);
    expect(rec?.result).toBe("NOT_IMPROVING");
    const pkg = await loadPackage(w, rec?.packageId ?? "");
    expect(pkg.payload.verification.result).toBe("NOT_IMPROVING");
    expect(pkg.payload.verification.reasonCodes).toContain("VIBRATION:STILL_MATERIALLY_ABNORMAL");
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("NOT_IMPROVING");
  });

  it("PARTIALLY_VERIFIED: improved but not at target", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("partial-improvement", 25);
    await w.runtime.tick();
    const rec = await w.latestPackage(caseId);
    expect(rec?.result).toBe("PARTIALLY_VERIFIED");
    const pkg = await loadPackage(w, rec?.packageId ?? "");
    expect(pkg.payload.verification.result).toBe("PARTIALLY_VERIFIED");
    expect(pkg.payload.verification.result).not.toBe("VERIFIED");
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("PARTIALLY_VERIFIED");
  });
});

describe("E6 later case activity creates a new package; history stays intact", () => {
  it("NOT_IMPROVING then VERIFIED gives two packages; the first is untouched and still accessible", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick();
    const first = await w.latestPackage(caseId);
    const firstPkg = await loadPackage(w, first?.packageId ?? "");
    await w.reportAction(caseId, undefined, true);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const records = await w.runtime.evidencePackages.listByCase(ORG, caseId);
    expect(records.map((r) => r.result)).toEqual(["NOT_IMPROVING", "VERIFIED"]);
    expect(new Set(records.map((r) => r.packageId)).size).toBe(2);
    expect((await w.latestPackage(caseId))?.packageId).toBe(records[1]?.packageId);
    expect(await loadPackage(w, first?.packageId ?? "")).toEqual(firstPkg);
    const second = await loadPackage(w, records[1]?.packageId ?? "");
    expect(second.payload.recurrence.priorVerificationIds).toEqual([firstPkg.verificationId]);
    const list = await w.api("GET", `/api/v1/cases/${caseId}`, MGR);
    expect(list.body.evidencePackages.map((r: Json) => r.result)).toEqual([
      "NOT_IMPROVING",
      "VERIFIED",
    ]);
  });

  it("a recurrence reopens the case without touching the old package; a new verification adds a new one", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const first = await w.latestPackage(caseId);
    const firstPkg = await loadPackage(w, first?.packageId ?? "");
    await w.send("normal", 12);
    await w.send("compound-outdoor-heat", 3);
    expect((await w.runtime.cases.get(ORG, caseId))?.state).toBe("REOPENED");
    expect((await w.latestPackage(caseId))?.packageId).toBe(first?.packageId); // no new fact yet
    expect(await w.runtime.evidencePackages.listByCase(ORG, caseId)).toHaveLength(1);

    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const records = await w.runtime.evidencePackages.listByCase(ORG, caseId);
    expect(records).toHaveLength(2);
    expect((await w.latestPackage(caseId))?.packageId).toBe(records[1]?.packageId);
    expect(await loadPackage(w, first?.packageId ?? "")).toEqual(firstPkg);
    const second = await loadPackage(w, records[1]?.packageId ?? "");
    expect(second.payload.caseIdentity.recurrenceCount).toBe(1);
    expect(second.payload.recurrence.priorVerificationIds).toEqual([firstPkg.verificationId]);
  });
});

describe("E7 internal evidence access is permissioned, tenant-scoped and audited", () => {
  it("the insured can read; another tenant and unprivileged roles cannot; reads are audited", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const rec = await w.latestPackage(caseId);
    const id = rec?.packageId ?? "";
    expect((await w.api("GET", `/api/v1/evidence/${id}`, MGR)).status).toBe(200);
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-AUDITOR-001")).status).toBe(200);
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-ORG-ADMIN-001")).status).toBe(200);
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-OPERATOR-001")).status).toBe(403);
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-OTHER-ORG-MGR-001")).status).toBe(
      404,
    );
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-RISK-ENGINEER-001")).status).toBe(
      403,
    );
    expect((await w.api("GET", "/api/v1/evidence/EVP-NOPE", MGR)).status).toBe(404);
    expect((await w.api("GET", `/api/v1/evidence/${id}`, "USR-NOBODY")).status).toBe(401);
    expect((await w.api("POST", `/api/v1/evidence/${id}`, MGR, {})).status).toBe(405);
    const reads = (await w.runtime.audit.list(ORG)).filter(
      (e) => e.action === "EVIDENCE_PACKAGE_READ",
    );
    expect(reads.map((e) => e.actorId)).toEqual([MGR, "USR-AUDITOR-001", "USR-ORG-ADMIN-001"]);
    expect(reads[0]).toMatchObject({ targetType: "EVIDENCE_PACKAGE", targetId: id });
  });
});
