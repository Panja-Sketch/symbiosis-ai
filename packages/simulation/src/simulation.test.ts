import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDGE_PATHS } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import {
  InMemoryDeviceKeyStore,
  InMemoryDeviceRegistry,
  createEdgeDeviceRecord,
} from "@symbiosis/device-registry";
import { InMemoryReplayGuard, authenticateEdgeRequest } from "@symbiosis/edge-security";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import {
  NORMAL_VALUES,
  NUMERIC_BOUNDS,
  SIMULATION_FACILITY_SCHEMA,
  createSimulationControl,
  createSimulationEngine,
  parseFacilityModel,
  parseScenarios,
  validateStatePatch,
  valuesAt,
} from "./index";
import type { EdgeSubmitRequest, FacilityModel, Scope } from "./index";

const cfg = (p: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "config", "simulation", p), "utf8"),
  ) as unknown;
const facility = parseFacilityModel(cfg("facility.v1.json"));
const scenarios = parseScenarios(cfg("scenarios.v1.json"));
const scope: Scope = { organizationId: facility.organizationId, facilityId: facility.facilityId };
const actor = { actorId: "USR-ORG-ADMIN-001" };
const T0 = Date.parse("2026-10-02T10:00:02.000Z");

describe("facility and scenario configuration", () => {
  it("parses the shipped facility and scenarios", () => {
    expect(facility.devices.map((d) => d.profileId).sort()).toEqual([
      "sim-electrical-meter",
      "sim-hvac-controller",
      "sim-vibration-gateway",
    ]);
    expect(scenarios.map((s) => s.id)).toHaveLength(7);
  });

  it("rejects a malformed facility and a scenario that tries to carry an outcome", () => {
    const raw = cfg("facility.v1.json") as Record<string, unknown>;
    expect(() => parseFacilityModel({ ...raw, schema: "x" })).toThrow();
    expect(() =>
      parseFacilityModel({ ...raw, location: { label: "x", latitude: 200, longitude: 0 } }),
    ).toThrow();
    expect(() => parseFacilityModel({ ...raw, devices: [] })).toThrow();
    const sc = cfg("scenarios.v1.json") as { scenarios: Record<string, unknown>[] };
    const bad = (mutate: (s: Record<string, unknown>) => void) => () => {
      const copy = structuredClone(sc);
      mutate(copy.scenarios[2] as Record<string, unknown>);
      parseScenarios(copy);
    };
    expect(bad((s) => (s.verificationResult = "NOT_IMPROVING"))).toThrow(/unknown key/);
    expect(bad((s) => (s.severity = "CRITICAL"))).toThrow(/unknown key/);
    expect(bad((s) => (s.createCase = true))).toThrow(/unknown key/);
    expect(bad((s) => ((s.values as Record<string, unknown>).vibrationRmsMs2 = 1e9))).toThrow();
    expect(bad((s) => (s.rampSeconds = -1))).toThrow();
    expect(bad((s) => (s.id = "SURPRISE"))).toThrow();
  });

  it("no scenario value is outside the hard bounds", () => {
    for (const s of scenarios) expect(validateStatePatch(s.values).ok, s.id).toBe(true);
    expect(SIMULATION_FACILITY_SCHEMA).toBe("simulation-facility.v1");
  });
});

describe("state validation (strict bounds)", () => {
  const ok = (p: unknown) => validateStatePatch(p).ok;
  const issues = (p: unknown) => {
    const r = validateStatePatch(p);
    return r.ok ? [] : r.issues;
  };

  it("accepts values on the boundaries and refuses values just outside", () => {
    for (const [field, b] of Object.entries(NUMERIC_BOUNDS)) {
      expect(ok({ [field]: b.min }), `${field} min`).toBe(true);
      expect(ok({ [field]: b.max }), `${field} max`).toBe(true);
      expect(ok({ [field]: b.min - 0.0001 }), `${field} below`).toBe(false);
      expect(ok({ [field]: b.max + 0.0001 }), `${field} above`).toBe(false);
    }
  });

  it("refuses NaN, Infinity, strings, null, arrays and unknown fields", () => {
    for (const v of [Number.NaN, Infinity, -Infinity, "5", null, [1], {}, true, undefined]) {
      expect(ok({ vibrationRmsMs2: v }), String(v)).toBe(false);
    }
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok("x")).toBe(false);
    expect(ok({})).toBe(false);
    expect(issues({ caseState: "VERIFIED_IMPROVED" }).join()).toMatch(/unknown field/);
    expect(issues({ severity: "HIGH", verificationResult: "VERIFIED" }).length).toBe(2);
    expect(ok({ __proto__: { vibrationRmsMs2: 1 }, vibrationRmsMs2: 1 })).toBe(true);
    expect(ok({ backupRunning: "yes" })).toBe(false);
    expect(ok({ backupRunning: 1 })).toBe(false);
  });

  it("validates sensor conditions: health enum, whole-number staleness, boolean dropout", () => {
    expect(
      ok({ sensors: { vibration: { health: "FAULT", staleSeconds: 3600, dropout: true } } }),
    ).toBe(true);
    expect(ok({ sensors: { vibration: { health: "BROKEN" } } })).toBe(false);
    expect(ok({ sensors: { vibration: { staleSeconds: 3601 } } })).toBe(false);
    expect(ok({ sensors: { vibration: { staleSeconds: -1 } } })).toBe(false);
    expect(ok({ sensors: { vibration: { staleSeconds: 1.5 } } })).toBe(false);
    expect(ok({ sensors: { vibration: { dropout: "yes" } } })).toBe(false);
    expect(ok({ sensors: { toaster: { health: "FAULT" } } })).toBe(false);
    expect(ok({ sensors: { vibration: { colour: "red" } } })).toBe(false);
    expect(ok({ sensors: "all" })).toBe(false);
  });
});

describe("state history", () => {
  const rev = (
    revision: number,
    atMs: number,
    over: Partial<typeof NORMAL_VALUES> = {},
    rampMs = 0,
    from = NORMAL_VALUES,
  ) => ({
    sessionId: "S",
    revision,
    atMs,
    values: { ...NORMAL_VALUES, ...over },
    rampMs,
    ...(rampMs > 0 && { rampFrom: from }),
    setBy: "u",
    note: "n",
  });

  it("steps at the revision time and ramps linearly", () => {
    const h = [rev(1, 0), rev(2, 1000, { vibrationRmsMs2: 0.6 }, 10_000)];
    expect(valuesAt(h, 500).vibrationRmsMs2).toBe(0.3);
    expect(valuesAt(h, 1000).vibrationRmsMs2).toBe(0.3);
    expect(valuesAt(h, 6000).vibrationRmsMs2).toBeCloseTo(0.45, 6);
    expect(valuesAt(h, 11_000).vibrationRmsMs2).toBeCloseTo(0.6, 6);
    expect(valuesAt(h, 99_000).vibrationRmsMs2).toBe(0.6);
  });

  it("uses the highest revision at or before the time, not a later one", () => {
    const h = [rev(1, 0), rev(3, 5000, { currentA: 20 }), rev(2, 2000, { currentA: 15 })];
    expect(valuesAt(h, 3000).currentA).toBe(15);
    expect(valuesAt(h, 6000).currentA).toBe(20);
    expect(valuesAt([], 0)).toEqual(NORMAL_VALUES);
  });
});

function world(options: { baselinesReady?: boolean } = {}) {
  const clock = new ManualClock(T0);
  const ids = new SequentialIdGenerator();
  const store = new InMemoryTenantDocumentStore();
  const audit = new InMemoryAuditLog();
  const purged: Scope[] = [];
  const control = createSimulationControl({
    clock,
    ids,
    store,
    audit,
    facility,
    scenarios,
    reset: {
      purge: async (s) => {
        purged.push(s);
        return { cases: 2, observations: 40 };
      },
    },
    ...(options.baselinesReady !== undefined && {
      baselinesReady: async () => options.baselinesReady as boolean,
    }),
  });
  return { clock, ids, store, audit, control, purged };
}

describe("session control", () => {
  it("creates a STOPPED known-normal session on first use and starts it once", async () => {
    const w = world();
    const v = await w.control.view();
    expect(v.session).toMatchObject({
      status: "STOPPED",
      generation: 1,
      scenarioId: "NORMAL",
      clockMode: "REAL_TIME",
      revision: 1,
    });
    expect(v.values).toEqual(NORMAL_VALUES);
    expect(v.liveness).toBe("STOPPED");
    expect(v.clock.label).toMatch(/Real time/);
    const a = await w.control.start(scope, actor);
    const b = await w.control.start(scope, actor);
    expect(a.status).toBe("RUNNING");
    expect(b.startedAt).toBe(a.startedAt);
    expect(
      (await w.audit.list(facility.organizationId)).filter(
        (e) => e.action === "SIMULATION_STARTED",
      ),
    ).toHaveLength(1);
  });

  it("refuses every command outside the simulation tenant and facility", async () => {
    const w = world();
    for (const bad of [
      { organizationId: "ORG-SIM-002", facilityId: facility.facilityId },
      { organizationId: facility.organizationId, facilityId: "FAC-SIM-001" },
      { organizationId: "ORG-INS-001", facilityId: "FAC-X" },
    ]) {
      await expect(w.control.start(bad, actor)).rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
      await expect(w.control.stop(bad, actor)).rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
      await expect(w.control.setState(bad, actor, { currentA: 13 })).rejects.toMatchObject({
        code: "OUT_OF_SCOPE",
      });
      await expect(w.control.applyScenario(bad, actor, "NORMAL")).rejects.toMatchObject({
        code: "OUT_OF_SCOPE",
      });
      await expect(w.control.reset(bad, actor, "RESET")).rejects.toMatchObject({
        code: "OUT_OF_SCOPE",
      });
    }
    expect(w.purged).toHaveLength(0);
  });

  it("applies a scenario with a ramp, records it and audits who and what changed", async () => {
    const w = world();
    await w.control.start(scope, actor);
    const r = await w.control.applyScenario(scope, actor, "EMERGING_DETERIORATION");
    expect(r.session).toMatchObject({
      scenarioId: "EMERGING_DETERIORATION",
      weatherMode: "SIMULATED",
      revision: 2,
    });
    w.clock.advance(75_000);
    expect((await w.control.view()).values.vibrationRmsMs2).toBeCloseTo(0.36, 2); // halfway up the ramp
    w.clock.advance(100_000);
    expect((await w.control.view()).values.vibrationRmsMs2).toBeCloseTo(0.42, 4);
    const audit = (await w.audit.list(facility.organizationId)).filter(
      (e) => e.action === "SIMULATION_SCENARIO_APPLIED",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: "USR-ORG-ADMIN-001", targetType: "SIMULATION" });
    expect(audit[0]?.details?.changes).toEqual(
      expect.arrayContaining([expect.stringContaining("vibrationRmsMs2: 0.3 -> 0.42")]),
    );
  });

  it("rejects an unknown scenario and invalid manual changes with the reasons", async () => {
    const w = world();
    await expect(w.control.applyScenario(scope, actor, "MELTDOWN")).rejects.toMatchObject({
      code: "UNKNOWN_SCENARIO",
    });
    await expect(
      w.control.setState(scope, actor, { vibrationRmsMs2: Number.NaN }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      w.control.setState(scope, actor, { caseState: "VERIFIED_IMPROVED" }),
    ).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      issues: [expect.stringMatching(/unknown field/)],
    });
    await expect(w.control.setState(scope, actor, { currentA: 12 })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    }); // no change
    expect((await w.control.view()).session.revision).toBe(1);
  });

  it("applies a manual change on top of the current world and marks the scenario MANUAL", async () => {
    const w = world();
    const s = await w.control.setState(scope, actor, {
      vibrationRmsMs2: 0.31,
      sensors: { meter: { staleSeconds: 30 } },
    });
    expect(s.scenarioId).toBe("MANUAL");
    const v = await w.control.view();
    expect(v.values).toMatchObject({
      vibrationRmsMs2: 0.31,
      currentA: 12,
      sensors: { meter: { staleSeconds: 30 } },
    });
  });

  it("detects a concurrent change with an expected revision", async () => {
    const w = world();
    const first = await w.control.setState(
      scope,
      actor,
      { zoneTemperatureC: 4.4 },
      { expectedRevision: 1 },
    );
    expect(first.revision).toBe(2);
    await expect(
      w.control.setState(scope, actor, { zoneTemperatureC: 4.5 }, { expectedRevision: 1 }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect((await w.control.view()).values.zoneTemperatureC).toBe(4.4);
  });

  it("concurrent commands each get their own revision", async () => {
    const w = world();
    await Promise.all([
      w.control.setState(scope, actor, { zoneTemperatureC: 4.4 }),
      w.control.setState(scope, actor, { relativeHumidityPct: 60 }),
      w.control.setState(scope, actor, { loadPercent: 70 }),
    ]);
    const revs = await w.control.revisions();
    expect(revs.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
  });

  it("blocks abnormal worlds while the baseline is still learning, but never normal ones", async () => {
    const w = world({ baselinesReady: false });
    await expect(
      w.control.applyScenario(scope, actor, "COMPOUND_COOLING_RISK"),
    ).rejects.toMatchObject({ code: "BASELINE_LEARNING" });
    await expect(w.control.setState(scope, actor, { vibrationRmsMs2: 0.9 })).rejects.toMatchObject({
      code: "BASELINE_LEARNING",
    });
    expect((await w.control.applyScenario(scope, actor, "NORMAL")).session.scenarioId).toBe(
      "NORMAL",
    );
    await w.control.setState(scope, actor, { relativeHumidityPct: 58 });
    const ready = world({ baselinesReady: true });
    expect(
      (await ready.control.applyScenario(scope, actor, "COMPOUND_COOLING_RISK")).session.scenarioId,
    ).toBe("COMPOUND_COOLING_RISK");
  });

  it("changes the weather mode only to LIVE or SIMULATED", async () => {
    const w = world();
    expect((await w.control.setWeatherMode(scope, actor, "SIMULATED")).weatherMode).toBe(
      "SIMULATED",
    );
    await expect(w.control.setWeatherMode(scope, actor, "FAKE")).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });

  it("reset needs the typed confirmation, clears only the simulation facility, ends STOPPED on a new generation and keeps the sequence", async () => {
    const w = world();
    await w.control.start(scope, actor);
    await w.control.applyScenario(scope, actor, "EMERGING_DETERIORATION");
    const before = (await w.control.view()).session;
    await expect(w.control.reset(scope, actor, "yes")).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    await expect(w.control.reset(scope, actor, undefined)).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    expect(w.purged).toHaveLength(0);
    w.clock.advance(10_000);
    const after = await w.control.reset(scope, actor, "RESET");
    expect(w.purged).toEqual([scope]);
    expect(after).toMatchObject({
      generation: 2,
      status: "STOPPED",
      scenarioId: "NORMAL",
      revision: 1,
      resets: 1,
    });
    expect(after.seqCursor).toBeGreaterThanOrEqual(before.seqCursor);
    expect((await w.control.view()).values).toEqual(NORMAL_VALUES);
    expect(await w.control.revisions()).toHaveLength(1);
    const e = (await w.audit.list(facility.organizationId)).find(
      (x) => x.action === "SIMULATION_RESET",
    );
    expect(e?.details?.removed).toEqual(expect.arrayContaining(["cases: 2", "observations: 40"]));
    // the finished session is kept as history
    expect(
      await w.store.get("simulationSessions", facility.organizationId, before.sessionId),
    ).toBeDefined();
  });

  it("reset waits for an emission in flight and refuses when it never ends", async () => {
    const w = world();
    await w.control.start(scope, actor);
    await w.store.update(
      "simulationControl",
      facility.organizationId,
      facility.facilityId,
      (c: Record<string, unknown> | undefined) => ({
        doc: { ...(c ?? {}), lease: { holder: "x", untilMs: T0 + 3_600_000 } },
      }),
    );
    // the manual clock never advances, so the 15 s wait would never end: use a real-time clock stub
    const real = {
      nowMs: (() => {
        let t = T0;
        return () => (t += 8000);
      })(),
    };
    const w2 = createSimulationControl({
      clock: real,
      ids: w.ids,
      store: w.store,
      audit: w.audit,
      facility,
      scenarios,
      reset: { purge: async () => ({}) },
    });
    await expect(w2.reset(scope, actor, "RESET")).rejects.toMatchObject({ code: "BUSY" });
  });
});

/* ---------------------------------------------------------------------------------------------- */

async function engineWorld(over: { facility?: FacilityModel } = {}) {
  const w = world();
  const keys = new Map<string, Uint8Array>();
  const records = facility.devices.map((d, i) => {
    keys.set(`${d.deviceId}|${d.keyId}`, new Uint8Array(32).fill(i + 1));
    return createEdgeDeviceRecord({
      deviceId: d.deviceId,
      keyId: d.keyId,
      organizationId: facility.organizationId,
      facilityId: facility.facilityId,
      assetId: d.assetId,
      ...(d.assetMapping !== undefined && { assetMapping: d.assetMapping }),
      expectedSignals: [...d.expectedSignals],
      sourceProfile: { profileId: d.profileId },
    });
  });
  const registry = new InMemoryDeviceRegistry(records);
  const keyStore = new InMemoryDeviceKeyStore(
    facility.devices.map((d) => ({
      deviceId: d.deviceId,
      keyId: d.keyId,
      key: keys.get(`${d.deviceId}|${d.keyId}`) as Uint8Array,
    })),
  );
  const replay = new InMemoryReplayGuard();
  const accepted: {
    target: string;
    deviceId: string;
    seq: number;
    payload: Record<string, unknown>;
  }[] = [];
  const rejected: { target: string; code: string }[] = [];
  const submit = async (req: EdgeSubmitRequest) => {
    const auth = await authenticateEdgeRequest(
      { registry, keys: keyStore, replayGuard: replay, clock: w.clock },
      { method: req.method, path: req.target, headers: req.headers, rawBody: req.rawBody },
    );
    if (!auth.ok) {
      rejected.push({ target: req.target, code: auth.error.code });
      return { status: 401, body: { error: { code: auth.error.code } } };
    }
    accepted.push({
      target: req.target,
      deviceId: auth.value.deviceId,
      seq: auth.value.seq,
      payload: JSON.parse(new TextDecoder().decode(req.rawBody)) as Record<string, unknown>,
    });
    return { status: req.target === EDGE_PATHS.heartbeat ? 200 : 202, body: {} };
  };
  const pulses: number[] = [];
  const engine = createSimulationEngine({
    clock: w.clock,
    ids: w.ids,
    store: w.store,
    facility: over.facility ?? facility,
    registry,
    keys: keyStore,
    submit,
    onPulse: async () => void pulses.push(1),
  });
  return { ...w, engine, accepted, rejected, registry, pulses };
}

describe("engine: signed vendor payloads into the edge boundary", () => {
  it("does nothing until the session runs", async () => {
    const w = await engineWorld();
    expect(await w.engine.pulse(scope, undefined)).toMatchObject({ status: "STOPPED", sent: 0 });
    expect(w.accepted).toHaveLength(0);
  });

  it("sends one signed vendor payload per device per 5-second instant, on a shared grid", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    w.clock.advance(23_000); // T0+23 s -> instants at +... the grid ones after start
    const r = await w.engine.pulse(scope, undefined);
    expect(r.status).toBe("OK");
    const samples = w.accepted.filter((a) => a.target === EDGE_PATHS.source);
    expect(w.rejected).toEqual([]);
    expect(r.instants).toBeGreaterThanOrEqual(3);
    expect(samples).toHaveLength(r.instants * 3);
    // heartbeats first, one per device, then samples
    const hb = w.accepted.filter((a) => a.target === EDGE_PATHS.heartbeat);
    expect(hb.map((h) => h.deviceId).sort()).toEqual(
      facility.devices.map((d) => d.deviceId).sort(),
    );
    expect(w.pulses).toHaveLength(1);
    // each vendor keeps its own shape and unit
    const vib = samples.find((s) => s.deviceId === "DEV-SIM-VIB-01")?.payload as {
      rms: { unit: string; value: number };
      sampledAtMs: number;
    };
    expect(vib.rms.unit).toBe("g");
    expect(vib.sampledAtMs % 5000).toBe(0);
    const meter = samples.find((s) => s.deviceId === "DEV-SIM-PWR-01")?.payload as {
      totals: { current: { u: string } };
      t: number;
    };
    expect(meter.totals.current.u).toBe("mA");
    expect(meter.t * 1000).toBe(vib.sampledAtMs);
    const hvac = samples.find((s) => s.deviceId === "DEV-SIM-HVAC-01")?.payload as {
      zone: { temp: { unit: string } };
    };
    expect(hvac.zone.temp.unit).toBe("degF");
    // sequence numbers strictly increase per device (the replay guard accepted them all)
    for (const d of facility.devices) {
      const seqs = w.accepted.filter((a) => a.deviceId === d.deviceId).map((a) => a.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });

  it("never re-sends an instant and never back-fills more than the last minute", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    w.clock.advance(10_000);
    const a = await w.engine.pulse(scope, undefined);
    const again = await w.engine.pulse(scope, undefined);
    expect(again.instants).toBe(0);
    const sentSoFar = w.accepted.filter((x) => x.target === EDGE_PATHS.source).length;
    expect(sentSoFar).toBe(a.instants * 3);
    w.clock.advance(10 * 60_000); // the browser was closed for ten minutes
    const b = await w.engine.pulse(scope, undefined);
    expect(b.instants).toBe(12); // a bounded catch-up, an honest gap before it
    expect(w.rejected).toEqual([]);
  });

  it("replays the world as it was at each instant, including ramps", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    w.clock.advance(5_000);
    await w.control.applyScenario(scope, actor, "COMPOUND_COOLING_RISK"); // 20 s ramp starting now
    w.clock.advance(30_000);
    await w.engine.pulse(scope, undefined);
    const vibs = w.accepted
      .filter((a) => a.deviceId === "DEV-SIM-VIB-01" && a.target === EDGE_PATHS.source)
      .map((a) => ({
        t: (a.payload as { sampledAtMs: number }).sampledAtMs,
        ms2: (a.payload as { rms: { value: number } }).rms.value * 9.80665,
      }))
      .sort((x, y) => x.t - y.t);
    expect(vibs.length).toBeGreaterThanOrEqual(5);
    expect(vibs[0]?.ms2).toBeLessThan(0.34);
    expect(vibs[vibs.length - 1]?.ms2).toBeGreaterThan(0.58);
    for (let i = 1; i < vibs.length; i += 1)
      expect(vibs[i]?.t).toBeGreaterThan(vibs[i - 1]?.t ?? 0);
  });

  it("is deterministic: the same world and instants give the same payload bytes", async () => {
    const run = async () => {
      const w = await engineWorld();
      await w.control.start(scope, actor);
      w.clock.advance(15_000);
      await w.engine.pulse(scope, undefined);
      return JSON.stringify(
        w.accepted.filter((a) => a.target === EDGE_PATHS.source).map((a) => a.payload),
      );
    };
    expect(await run()).toBe(await run());
  });

  it("sensor conditions become real source behavior: dropout sends nothing, stale ages the stamp, health rides the heartbeat", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    await w.control.setState(scope, actor, {
      sensors: {
        vibration: { dropout: true, health: "FAULT" },
        meter: { staleSeconds: 600, health: "DEGRADED" },
      },
    });
    w.clock.advance(12_000);
    await w.engine.pulse(scope, undefined);
    const bySource = (id: string) =>
      w.accepted.filter((a) => a.deviceId === id && a.target === EDGE_PATHS.source);
    expect(bySource("DEV-SIM-VIB-01")).toHaveLength(0);
    expect(bySource("DEV-SIM-PWR-01").length).toBeGreaterThan(0);
    const stamp = (bySource("DEV-SIM-PWR-01")[0]?.payload as { t: number }).t * 1000;
    expect(stamp).toBeLessThan(w.clock.nowMs() - 590_000);
    const hbs = w.accepted.filter((a) => a.target === EDGE_PATHS.heartbeat);
    expect(
      (hbs.find((h) => h.deviceId === "DEV-SIM-VIB-01")?.payload as { health: string }).health,
    ).toBe("FAULT");
    expect(
      (hbs.find((h) => h.deviceId === "DEV-SIM-PWR-01")?.payload as { health: string }).health,
    ).toBe("DEGRADED");
  });

  it("refuses a pulse from an old generation after a reset and one outside the scope", async () => {
    const w = await engineWorld();
    const s = await w.control.start(scope, actor);
    w.clock.advance(10_000);
    await w.engine.pulse(scope, s.generation);
    await w.control.reset(scope, actor, "RESET");
    await w.control.start(scope, actor);
    w.clock.advance(10_000);
    await expect(w.engine.pulse(scope, s.generation)).rejects.toMatchObject({
      code: "SESSION_RESET",
    });
    await expect(
      w.engine.pulse({ organizationId: "ORG-SIM-002", facilityId: facility.facilityId }, undefined),
    ).rejects.toMatchObject({ code: "OUT_OF_SCOPE" });
  });

  it("two concurrent pulses cannot both emit the same instants", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    w.clock.advance(20_000);
    const [a, b] = await Promise.all([
      w.engine.pulse(scope, undefined),
      w.engine.pulse(scope, undefined),
    ]);
    expect([a.status, b.status].sort()).toEqual(["BUSY", "OK"]);
    expect(w.rejected).toEqual([]);
    const seen = w.accepted
      .filter((x) => x.target === EDGE_PATHS.source && x.deviceId === "DEV-SIM-VIB-01")
      .map((x) => (x.payload as { sampledAtMs: number }).sampledAtMs);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("reports a rejection from the edge instead of hiding it", async () => {
    const w = await engineWorld();
    await w.control.start(scope, actor);
    await w.registry.recordSeen("DEV-SIM-VIB-01", { seenAt: "x" }); // device still exists
    // break one device's key: the engine cannot sign for it
    const broken = createSimulationEngine({
      clock: w.clock,
      ids: w.ids,
      store: w.store,
      facility,
      registry: w.registry,
      keys: new InMemoryDeviceKeyStore([]),
      submit: async () => ({ status: 202, body: {} }),
    });
    w.clock.advance(10_000);
    const r = await broken.pulse(scope, undefined);
    expect(r.sent).toBe(0);
    expect(r.rejected.length).toBeGreaterThan(0);
    expect(r.rejected[0]?.code).toBe("NO_DEVICE_KEY");
  });
});
