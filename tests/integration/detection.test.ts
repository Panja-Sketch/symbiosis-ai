import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import type { PlatformEvent } from "@symbiosis/contracts";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime } from "../../scripts/local-runtime";

const ORG = "ORG-SIM-001";
const FAN_A = "AST-SIM-FAN-A";

let runtime: LocalRuntime;
let clock: ManualClock;
let client: SimulatorClient;
let step: number;

beforeEach(async () => {
  clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  runtime = await createLocalRuntime({ clock, ids: new SequentialIdGenerator() });
  client = new SimulatorClient({
    baseUrl: runtime.server.baseUrl,
    deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
    keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
    key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
    clock,
    initialSeq: 1,
  });
  step = 0;
  expect((await client.sendHeartbeat("HEALTHY")).status).toBe(200);
});

afterEach(async () => {
  await runtime.close();
});

/** Sends `count` samples of a scenario, 5 s apart in simulated time (no real waiting). */
async function run(scenario: ScenarioName, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const res = await client.sendTelemetry(scenarioReadings(scenario, i));
    expect(res.status).toBe(202);
    clock.advance(5000);
    step += 1;
  }
}

const types = (events: readonly PlatformEvent[]) => events.map((e) => e.event_type);
const ofType = <T extends PlatformEvent["event_type"]>(type: T) =>
  runtime.bus
    .history()
    .filter((e): e is Extract<PlatformEvent, { event_type: T }> => e.event_type === type);

/** 25 samples at 5 s = exactly the default 120 s warm-up (first sample at t=0, last at t=120). */
const warmUp = () => run("normal", 25);

describe("Scenario A: baseline established from known-normal data", () => {
  it("learns, then becomes READY after the default 2-minute window, with no risk", async () => {
    await run("normal", 10);
    let vib = await runtime.baselines.listActive(ORG, "FAC-SIM-001");
    expect(vib.filter((b) => b.status === "LEARNING").length).toBeGreaterThan(0);
    expect(vib.every((b) => b.status !== "READY")).toBe(true);
    await run("normal", 15);
    vib = await runtime.baselines.listActive(ORG, "FAC-SIM-001");
    const ready = vib
      .filter((b) => b.status === "READY")
      .map((b) => `${b.key.assetId}/${b.key.signal}`);
    expect(ready.sort()).toEqual([
      "AST-SIM-FAN-A/current",
      "AST-SIM-FAN-A/vibration_rms",
      "AST-SIM-ZONE-1/relative_humidity",
      "AST-SIM-ZONE-1/temperature",
    ]);
    expect(vib.find((b) => b.key.signal === "current")?.key.operatingMode).toBe("HIGH_LOAD");
    expect(await runtime.cases.list(ORG)).toEqual([]);
    expect(ofType("risk.detected.v1")).toHaveLength(0);
  });

  it("reports INSUFFICIENT_DATA while learning and NORMAL once the baseline is ready", async () => {
    await warmUp();
    await run("normal", 3);
    const evals = ofType("risk.observation_evaluated.v1");
    const vibration = evals.filter((e) => e.payload.signal === "vibration_rms");
    expect(vibration[0]?.payload.outcome).toBe("INSUFFICIENT_DATA");
    expect(vibration[0]?.payload.reasonCodes).toContain("BASELINE_NOT_STARTED:VIBRATION");
    expect(vibration.at(-1)?.payload.outcome).toBe("NORMAL");
    expect(vibration.at(-1)?.payload.baseline?.status).toBe("READY");
  });
});

describe("Scenario B/C: isolated anomalies never create the hero case", () => {
  it("isolated vibration anomaly is WATCH only", async () => {
    await warmUp();
    await run("isolated-vibration", 6);
    expect(await runtime.cases.list(ORG)).toEqual([]);
    expect(ofType("risk.detected.v1")).toHaveLength(0);
    const vib = ofType("risk.observation_evaluated.v1").filter(
      (e) => e.payload.signal === "vibration_rms",
    );
    expect(vib.at(-1)?.payload.outcome).toBe("WATCH");
    expect(vib.at(-1)?.payload.reasonCodes).toContain("SINGLE_SIGNAL_ABNORMAL");
  });

  it("isolated current anomaly creates no hero case", async () => {
    await warmUp();
    await run("isolated-current", 6);
    expect(await runtime.cases.list(ORG)).toEqual([]);
    const cur = ofType("risk.observation_evaluated.v1").filter(
      (e) => e.payload.signal === "current",
    );
    expect(cur.at(-1)?.payload.outcome).toBe("WATCH");
  });

  it("context alone (outdoor heat, normal asset signals) is NORMAL, not a risk", async () => {
    await warmUp();
    await run("context-only", 6);
    expect(await runtime.cases.list(ORG)).toEqual([]);
    const vib = ofType("risk.observation_evaluated.v1").filter(
      (e) => e.payload.signal === "vibration_rms",
    );
    expect(vib.at(-1)?.payload.outcome).toBe("NORMAL");
    expect(vib.at(-1)?.payload.reasonCodes).toEqual(["WITHIN_BASELINE"]);
  });

  it("vibration + current without context stays WATCH (CONTEXT_NOT_SATISFIED)", async () => {
    await warmUp();
    await run("compound-outdoor-heat", 0);
    // abnormal asset signals, but outdoor heat is below threshold and temperature is flat
    for (let i = 0; i < 5; i++) {
      await client.sendTelemetry({
        ...scenarioReadings("compound-outdoor-heat", i),
        outdoor_temperature_c: 30,
      });
      clock.advance(5000);
    }
    expect(await runtime.cases.list(ORG)).toEqual([]);
    const vib = ofType("risk.observation_evaluated.v1").filter(
      (e) => e.payload.signal === "vibration_rms",
    );
    expect(vib.at(-1)?.payload.outcome).toBe("WATCH");
    expect(vib.at(-1)?.payload.reasonCodes).toContain("CONTEXT_NOT_SATISFIED");
  });
});

describe("Scenario D: persistent compound deterioration", () => {
  it("detects once, creates exactly one case and one risk event, in the exact event order", async () => {
    await warmUp();
    const before = runtime.bus.history().length;
    await run("compound-outdoor-heat", 3);

    const detections = ofType("risk.detected.v1");
    expect(detections).toHaveLength(1);
    const d = detections[0]?.payload;
    expect(d).toMatchObject({
      ruleId: "RULE-COOLING-ELECTRICAL",
      ruleVersion: "1",
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      primaryAssetId: FAN_A,
      persistence: { qualifyingEvaluations: 3, required: 3 },
    });
    expect(d?.reasonCodes).toEqual(
      expect.arrayContaining([
        "VIBRATION_Z_AT_OR_ABOVE_THRESHOLD",
        "CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD",
        "OUTDOOR_HEAT_CONTEXT",
        "PERSISTED_3_OF_3",
      ]),
    );
    expect(d?.contextAssetIds).toEqual(["AST-SIM-OUTDOOR"]);

    const cases = await runtime.cases.list(ORG);
    expect(cases).toHaveLength(1);
    const c = cases[0]!;
    expect(c).toMatchObject({
      state: "OPEN",
      origin: { type: "DETECTED_HAZARD", detectionId: d?.detectionId },
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      organizationId: ORG,
      facilityId: "FAC-SIM-001",
      recurrenceCount: 0,
      sharingState: "NOT_SHARED",
    });
    expect(c.assetIds[0]).toBe(FAN_A);
    expect(c.assetIds).toContain("AST-SIM-OUTDOOR");
    expect(c.severity).toBe("MODERATE"); // current +12.2% is below the configured HIGH threshold (15%)

    const events = await runtime.riskEvents.listByCase(ORG, c.caseId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ state: "DETECTED", caseId: c.caseId });
    expect(c.activeRiskEventId).toBe(events[0]?.eventId);

    // baseline snapshot retained and resolvable
    const snapshot = await runtime.baselines.getSnapshot(ORG, c.baselineSnapshotId as string);
    expect(snapshot?.baselineIds).toHaveLength(2);
    expect(snapshot?.baselineIds.every((id) => id.startsWith("BSL:"))).toBe(true);

    // exact order within the detecting packet
    const tail = runtime.bus.history().slice(before);
    const lastQa = tail.map((e) => e.event_type).lastIndexOf("telemetry.quality_assessed.v1");
    const final = tail.slice(lastQa).map((e) => e.event_type);
    expect(final).toEqual([
      "telemetry.quality_assessed.v1",
      "risk.observation_evaluated.v1", // current
      "risk.observation_evaluated.v1", // outdoor_temperature
      "risk.observation_evaluated.v1", // temperature
      "risk.observation_evaluated.v1", // vibration_rms
      "risk.detected.v1",
      "case.created.v1",
    ]);
  });

  it("preserves correlation and causation across the whole chain", async () => {
    await warmUp();
    const before = runtime.bus.history().length;
    await run("compound-outdoor-heat", 3);
    const tail = runtime.bus.history().slice(before);
    const lastTelemetry = tail.map((e) => e.event_type).lastIndexOf("telemetry.received.v1");
    const chain = tail.slice(lastTelemetry);
    expect(new Set(chain.map((e) => e.correlation_id)).size).toBe(1);
    const byId = new Map(chain.map((e) => [e.event_id, e]));
    const qa = chain.find((e) => e.event_type === "telemetry.quality_assessed.v1")!;
    const detected = chain.find((e) => e.event_type === "risk.detected.v1")!;
    const created = chain.find((e) => e.event_type === "case.created.v1")!;
    for (const e of chain.filter((x) => x.event_type === "risk.observation_evaluated.v1")) {
      expect(e.causation_id).toBe(qa.event_id);
    }
    expect(byId.get(detected.causation_id as string)?.event_type).toBe(
      "risk.observation_evaluated.v1",
    );
    expect(created.causation_id).toBe(detected.event_id);
    for (const e of chain) {
      expect(e.organization_id).toBe(ORG);
      expect(e.facility_id).toBe("FAC-SIM-001");
      expect(e.schema_version).toBe("1.0");
    }
    expect(
      chain
        .filter((e) => e.event_type.startsWith("risk.") || e.event_type.startsWith("case."))
        .every((e) => e.producer === "worker"),
    ).toBe(true);
  });

  it("continued deterioration updates the same case instead of duplicating", async () => {
    await warmUp();
    await run("compound-outdoor-heat", 6);
    expect(await runtime.cases.list(ORG)).toHaveLength(1);
    const [c] = await runtime.cases.list(ORG);
    expect(await runtime.riskEvents.listByCase(ORG, c!.caseId)).toHaveLength(1);
    expect(ofType("case.created.v1")).toHaveLength(1);
    expect(ofType("risk.detected.v1")).toHaveLength(4); // instants 3..6
    expect(ofType("case.updated.v1")).toHaveLength(3);
    const lastUpdate = ofType("case.updated.v1").at(-1)?.payload;
    expect(lastUpdate).toMatchObject({ caseId: c?.caseId, change: "DETECTION_CONTINUED" });
  });

  it("detects through the rising zone-temperature branch as well", async () => {
    await warmUp();
    await run("compound-rising-temperature", 8);
    const detection = ofType("risk.detected.v1")[0]?.payload;
    expect(detection?.reasonCodes).toContain("ZONE_TEMPERATURE_RISING");
    expect(detection?.reasonCodes).not.toContain("OUTDOOR_HEAT_CONTEXT");
    expect(detection?.contextAssetIds).toEqual(["AST-SIM-ZONE-1"]);
    expect(await runtime.cases.list(ORG)).toHaveLength(1);
  });

  it("does not accumulate persistence across an interruption", async () => {
    await warmUp();
    await run("compound-outdoor-heat", 2);
    await run("normal", 1); // breaks the streak
    await run("compound-outdoor-heat", 2);
    expect(ofType("risk.detected.v1")).toHaveLength(0);
    await run("compound-outdoor-heat", 1);
    expect(ofType("risk.detected.v1")).toHaveLength(1);
  });
});

describe("Scenario E: insufficient baseline or data", () => {
  it("compound-looking data before any baseline is INSUFFICIENT_DATA and creates no case", async () => {
    await run("compound-outdoor-heat", 8);
    expect(await runtime.cases.list(ORG)).toEqual([]);
    expect(ofType("risk.detected.v1")).toHaveLength(0);
    const evals = ofType("risk.observation_evaluated.v1");
    expect(evals.length).toBeGreaterThan(0);
    for (const e of evals.filter((x) => x.payload.signal === "vibration_rms")) {
      expect(e.payload.outcome).toBe("INSUFFICIENT_DATA");
      expect(e.payload.instantOutcome).toBe("INSUFFICIENT_DATA");
    }
  });
});

describe("pipeline scope", () => {
  it("emits no S4+ events and the simulator still goes through authenticated ingestion", async () => {
    await warmUp();
    await run("compound-outdoor-heat", 4);
    const allowed = new Set([
      "telemetry.received.v1",
      "telemetry.authenticated.v1",
      "telemetry.normalized.v1",
      "telemetry.quality_assessed.v1",
      "risk.observation_evaluated.v1",
      "risk.detected.v1",
      "case.created.v1",
      "case.updated.v1",
    ]);
    for (const t of new Set(types(runtime.bus.history()))) expect(allowed.has(t)).toBe(true);
    // every observation was authenticated by the edge before reaching the pipeline
    const obs = await runtime.observations.list(ORG);
    expect(obs.length).toBeGreaterThan(0);
    expect(obs.every((o) => o.quality.authVerified && o.sourceType === "SIMULATOR")).toBe(true);
    expect(step).toBe(29);
  });
});
