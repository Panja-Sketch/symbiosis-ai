import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { baselineKeyString } from "@symbiosis/contracts";
import type {
  CanonicalObservation,
  CanonicalSignal,
  PlatformEvent,
  RiskImprovementCase,
  TelemetryQualityAssessedEvent,
} from "@symbiosis/contracts";
import { learn, parseBaselineConfig, startBaseline } from "@symbiosis/baselines";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryBus, SequentialIdGenerator, createEnvelope } from "@symbiosis/event-bus";
import {
  InMemoryBaselineRepository,
  InMemoryCaseRepository,
  InMemoryDetectionStateRepository,
  InMemoryRiskEventRepository,
  InMemoryVerificationRepository,
} from "@symbiosis/repositories";
import { parseRuleConfig } from "@symbiosis/risk-detection";
import { startRiskPipeline } from "./risk-pipeline";

const read = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "config", "rules", name), "utf8"),
  );
const baselineConfig = parseBaselineConfig(read("baselines.v1.json"));
const rule = parseRuleConfig({
  ...read("cooling-electrical.v1.json"),
  persistence: { minQualifyingEvaluations: 1, maxGapSeconds: 30 },
});

const ORG = "ORG-1";
const FAC = "FAC-1";
const t0 = Date.parse("2026-10-01T00:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const good = {
  confidence: 1,
  stale: false,
  outOfRange: false,
  deviceHealthy: true,
  authVerified: true,
};

let bus: InMemoryBus;
let baselines: InMemoryBaselineRepository;
let states: InMemoryDetectionStateRepository;
let cases: InMemoryCaseRepository;
let riskEvents: InMemoryRiskEventRepository;
let ids: SequentialIdGenerator;
let audit: InMemoryAuditLog;
let counter = 0;

async function seedBaselines(asset: string) {
  for (const [signal, mean] of [
    ["vibration_rms", 0.5],
    ["current", 100],
  ] as const) {
    let b = startBaseline(
      { organizationId: ORG, facilityId: FAC, assetId: asset, signal, operatingMode: "HIGH_LOAD" },
      1,
      baselineConfig,
    );
    for (let i = 0; i <= 24; i++) {
      b = learn(
        b,
        { value: mean, observedAt: at(-1000 + i * 5), trusted: true },
        baselineConfig,
      ).baseline;
    }
    await baselines.save(b);
  }
}

beforeEach(async () => {
  bus = new InMemoryBus();
  baselines = new InMemoryBaselineRepository();
  states = new InMemoryDetectionStateRepository();
  cases = new InMemoryCaseRepository();
  riskEvents = new InMemoryRiskEventRepository();
  ids = new SequentialIdGenerator();
  audit = new InMemoryAuditLog();
  counter = 0;
  startRiskPipeline({
    bus,
    ids,
    clock: new ManualClock(t0),
    baselines,
    detectionStates: states,
    cases,
    riskEvents,
    verifications: new InMemoryVerificationRepository(),
    audit,
    rule,
    baselineConfig,
  });
  await seedBaselines("AST-FAN");
});

const ob = (
  signal: CanonicalSignal,
  value: number,
  s: number,
  asset: string,
): CanonicalObservation => ({
  observationId: `OBS-${++counter}`,
  organizationId: ORG,
  facilityId: FAC,
  assetId: asset,
  deviceId: "DEV-1",
  signal,
  value,
  unit: signal === "outdoor_temperature" ? "degC" : "x",
  observedAt: at(s),
  receivedAt: at(s),
  sourceType: "SIMULATOR",
  sourceAdapter: "t",
  quality: good,
});

const compound = (s: number, asset = "AST-FAN", vib = 1.5, cur = 130): CanonicalObservation[] => [
  ob("current", cur, s, asset),
  ob("load_percent", 100, s, asset),
  ob("outdoor_temperature", 42, s, "AST-OUT"),
  ob("vibration_rms", vib, s, asset),
];

async function deliver(observations: CanonicalObservation[], s: number) {
  const event: TelemetryQualityAssessedEvent = createEnvelope(ids, {
    type: "telemetry.quality_assessed.v1",
    correlationId: `CORR-${s}`,
    causationId: null,
    organizationId: ORG,
    facilityId: FAC,
    occurredAt: at(s),
    producer: "worker",
    payload: { deviceId: "DEV-1", observations, assessments: [] },
  });
  await bus.publish(event);
}

const types = () => bus.history().map((e: PlatformEvent) => e.event_type as string);

describe("risk pipeline: case creation and correlation", () => {
  it("creates one case and one risk event for the first qualifying detection, with a baseline snapshot", async () => {
    await deliver(compound(0), 0);
    expect(types().filter((t) => t === "case.created.v1")).toHaveLength(1);
    const [c] = await cases.list(ORG);
    expect(c).toMatchObject({
      state: "OPEN",
      origin: { type: "DETECTED_HAZARD" },
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
    });
    expect(c?.assetIds[0]).toBe("AST-FAN");
    expect(await riskEvents.listByCase(ORG, c!.caseId)).toHaveLength(1);
    const snap = await baselines.getSnapshot(ORG, c!.baselineSnapshotId as string);
    expect([...(snap?.baselineIds ?? [])].sort()).toEqual([
      `BSL:${ORG}|${FAC}|AST-FAN|current|HIGH_LOAD:v1`,
      `BSL:${ORG}|${FAC}|AST-FAN|vibration_rms|HIGH_LOAD:v1`,
    ]);
  });

  it("continued detections update the same case instead of duplicating it", async () => {
    await deliver(compound(0), 0);
    await deliver(compound(5), 5);
    await deliver(compound(10), 10);
    expect(await cases.list(ORG)).toHaveLength(1);
    expect(types().filter((t) => t === "case.created.v1")).toHaveLength(1);
    expect(types().filter((t) => t === "case.updated.v1")).toHaveLength(2);
    const [c] = await cases.list(ORG);
    expect(await riskEvents.listByCase(ORG, c!.caseId)).toHaveLength(1);
    expect(c?.updatedAt).toBe(at(10));
  });

  it("severity can escalate on a continued detection but never drops", async () => {
    await deliver(compound(0, "AST-FAN", 1.125, 110), 0); // z 2.5, +10% -> MODERATE
    expect((await cases.list(ORG))[0]?.severity).toBe("MODERATE");
    await deliver(compound(5, "AST-FAN", 1.5, 130), 5); // HIGH
    expect((await cases.list(ORG))[0]?.severity).toBe("HIGH");
    await deliver(compound(10, "AST-FAN", 1.125, 110), 10); // back to MODERATE strength
    expect((await cases.list(ORG))[0]?.severity).toBe("HIGH");
    const updates = bus
      .history()
      .filter((e) => e.event_type === "case.updated.v1")
      .map((e) => (e.event_type === "case.updated.v1" ? e.payload : undefined));
    expect(updates[0]).toMatchObject({ previousSeverity: "MODERATE", severity: "HIGH" });
    expect(updates[1]).toMatchObject({ previousSeverity: "HIGH", severity: "HIGH" });
  });

  it("a different primary asset gets its own case (unrelated risks are not merged)", async () => {
    await seedBaselines("AST-FAN-2");
    await deliver(compound(0), 0);
    await deliver(compound(5, "AST-FAN-2"), 5);
    const all = await cases.list(ORG);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((c) => c.assetIds[0]))).toEqual(new Set(["AST-FAN", "AST-FAN-2"]));
  });

  it("an existing case for a different hazard on the same asset is not merged into", async () => {
    const other: RiskImprovementCase = {
      caseId: "CASE-OTHER",
      organizationId: ORG,
      facilityId: FAC,
      assetIds: ["AST-FAN"],
      origin: { type: "MANUAL_RISK_REVIEW", reviewId: "R-1" },
      hazardType: "REFRIGERANT_LEAK",
      title: "other",
      severity: "LOW",
      state: "OPEN",
      recurrenceCount: 0,
      sharingState: "NOT_SHARED",
      createdAt: at(-100),
      updatedAt: at(-100),
    };
    await cases.save(other);
    await deliver(compound(0), 0);
    const all = await cases.list(ORG);
    expect(all).toHaveLength(2);
    expect((await cases.get(ORG, "CASE-OTHER"))?.severity).toBe("LOW");
    expect((await cases.get(ORG, "CASE-OTHER"))?.updatedAt).toBe(at(-100));
  });

  it("a closed case is not an active episode: a new detection opens a new case", async () => {
    await cases.save({
      caseId: "CASE-OLD",
      organizationId: ORG,
      facilityId: FAC,
      assetIds: ["AST-FAN"],
      origin: { type: "DETECTED_HAZARD", detectionId: "D-0" },
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      title: "old",
      severity: "HIGH",
      state: "CLOSED",
      recurrenceCount: 0,
      sharingState: "NOT_SHARED",
      createdAt: at(-100),
      updatedAt: at(-100),
    });
    await deliver(compound(0), 0);
    expect(await cases.list(ORG)).toHaveLength(2);
  });

  it("records a continued detection on a case waiting in ACTION_REPORTED without resetting it (S4)", async () => {
    await deliver(compound(0), 0);
    const [c] = await cases.list(ORG);
    await cases.save({ ...c!, state: "ACTION_REPORTED" });
    await deliver(compound(5), 5);
    expect(await cases.list(ORG)).toHaveLength(1);
    expect((await cases.list(ORG))[0]?.state).toBe("ACTION_REPORTED");
    const updates = bus.history().filter((e) => e.event_type === "case.updated.v1");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.event_type === "case.updated.v1" && updates[0].payload).toMatchObject({
      change: "DETECTION_CONTINUED",
      state: "ACTION_REPORTED",
      previousState: "ACTION_REPORTED",
    });
    expect(types().filter((t) => t.startsWith("verification"))).toEqual([]);
  });

  it("records a continuing detection on a case that is VERIFYING (state preserved, no duplicate case)", async () => {
    await deliver(compound(0), 0);
    const [c] = await cases.list(ORG);
    await cases.save({ ...c!, state: "VERIFYING" });
    await deliver(compound(5), 5);
    expect(await cases.list(ORG)).toHaveLength(1);
    expect((await cases.list(ORG))[0]?.state).toBe("VERIFYING");
    expect(types().filter((t) => t === "case.updated.v1")).toHaveLength(1);
    expect(types().filter((t) => t === "risk.detected.v1")).toHaveLength(2);
  });

  it("every detection is auditable (case created, then each continued detection)", async () => {
    await deliver(compound(0), 0);
    await deliver(compound(5), 5);
    await deliver(compound(10), 10);
    const entries = await audit.list(ORG);
    expect(entries.map((e) => e.action)).toEqual([
      "CASE_CREATED",
      "DETECTION_RECORDED",
      "DETECTION_RECORDED",
    ]);
    expect(entries[0]?.details?.reasonCodes).toContain("OUTDOOR_HEAT_CONTEXT");
  });
});

describe("risk pipeline: events", () => {
  it("emits quality_assessed -> observation_evaluated -> detected -> case.created in order", async () => {
    await deliver(compound(0), 0);
    expect(types()).toEqual([
      "telemetry.quality_assessed.v1",
      "risk.observation_evaluated.v1", // current
      "risk.observation_evaluated.v1", // outdoor_temperature
      "risk.observation_evaluated.v1", // vibration_rms
      "risk.detected.v1",
      "case.created.v1",
    ]);
  });

  it("emits quality_assessed -> observation_evaluated -> detected -> case.updated for a continued episode", async () => {
    await deliver(compound(0), 0);
    await deliver(compound(5), 5);
    expect(types().slice(-5)).toEqual([
      "risk.observation_evaluated.v1",
      "risk.observation_evaluated.v1",
      "risk.observation_evaluated.v1",
      "risk.detected.v1",
      "case.updated.v1",
    ]);
  });

  it("links causation (evaluation -> detected -> case) and keeps correlation and identity", async () => {
    await deliver(compound(0), 0);
    const h = bus.history();
    const qa = h[0]!;
    const evals = h.filter((e) => e.event_type === "risk.observation_evaluated.v1");
    const detected = h.find((e) => e.event_type === "risk.detected.v1")!;
    const created = h.find((e) => e.event_type === "case.created.v1")!;
    for (const e of evals) expect(e.causation_id).toBe(qa.event_id);
    expect(evals.map((e) => e.event_id)).toContain(detected.causation_id);
    expect(created.causation_id).toBe(detected.event_id);
    for (const e of h) {
      expect(e.correlation_id).toBe("CORR-0");
      expect(e.organization_id).toBe(ORG);
      expect(e.facility_id).toBe(FAC);
      expect(e.schema_version).toBe("1.0");
    }
    expect(h.slice(1).every((e) => e.producer === "worker")).toBe(true);
  });

  it("emits nothing for an event with no observations", async () => {
    await deliver([], 0);
    expect(types()).toEqual(["telemetry.quality_assessed.v1"]);
  });

  it("emits no risk.detected for insufficient evidence", async () => {
    await deliver(
      compound(0).map((o) => ({ ...o, quality: { ...o.quality, authVerified: false } })),
      0,
    );
    expect(types()).not.toContain("risk.detected.v1");
    expect(await cases.list(ORG)).toEqual([]);
    const evals = bus.history().filter((e) => e.event_type === "risk.observation_evaluated.v1");
    expect(
      evals.every(
        (e) =>
          e.event_type === "risk.observation_evaluated.v1" &&
          e.payload.outcome === "INSUFFICIENT_DATA",
      ),
    ).toBe(true);
  });

  it("persists baseline learning and detector state across events", async () => {
    await deliver([ob("temperature", 4, 0, "AST-ZONE")], 0);
    expect(await states.get(`${ORG}|${FAC}|${rule.ruleId}`)).toBeDefined();
    const zone = (await baselines.listActive(ORG, FAC)).find((b) => b.key.assetId === "AST-ZONE");
    expect(zone).toMatchObject({ status: "LEARNING", observationCount: 1 });
    expect(baselineKeyString(zone!.key)).toContain("temperature|DEFAULT");
  });
});
