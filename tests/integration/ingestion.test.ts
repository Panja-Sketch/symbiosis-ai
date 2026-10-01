import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SimulatorClient } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { createLocalRuntime } from "../../scripts/local-runtime";
import type { LocalRuntime } from "../../scripts/local-runtime";

const START_MS = 1_790_000_000_000;

let runtime: LocalRuntime;
let clock: ManualClock;
let client: SimulatorClient;

function makeClient(over: { key?: Uint8Array; initialSeq?: number } = {}) {
  return new SimulatorClient({
    baseUrl: runtime.server.baseUrl,
    deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
    keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
    key: over.key ?? deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
    clock,
    initialSeq: over.initialSeq ?? 1,
  });
}

beforeEach(async () => {
  clock = new ManualClock(START_MS);
  runtime = await createLocalRuntime({ clock, ids: new SequentialIdGenerator() });
  client = makeClient();
});

afterEach(async () => {
  await runtime.close();
});

describe("simulator -> signed HTTP -> edge -> canonical observations", () => {
  it("ingests a valid signed heartbeat and telemetry packet end to end", async () => {
    expect((await client.sendHeartbeat("HEALTHY")).status).toBe(200);
    const res = await client.sendTelemetry();
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "accepted" });

    const observations = await runtime.observations.list(SYNTHETIC_DEV_DEVICE.organizationId);
    expect(observations.map((o) => o.signal).sort()).toEqual([
      "current",
      "equipment_running",
      "load_percent",
      "relative_humidity",
      "temperature",
      "vibration_rms",
    ]);
    for (const o of observations) {
      expect(o).toMatchObject({
        organizationId: "ORG-SIM-001",
        facilityId: "FAC-SIM-001",
        deviceId: "DEV-SIM-001",
        sourceType: "SIMULATOR",
        sourceAdapter: "simulator-edge-v1",
        observedAt: new Date(START_MS).toISOString(),
        quality: {
          confidence: 1,
          stale: false,
          outOfRange: false,
          deviceHealthy: true,
          authVerified: true,
        },
      });
    }
  });

  it("places each reading on its mapped logical asset (one device, several assets)", async () => {
    await client.sendHeartbeat("HEALTHY");
    await client.sendTelemetry();
    const bySignal = Object.fromEntries(
      (await runtime.observations.list("ORG-SIM-001")).map((o) => [o.signal, o.assetId]),
    );
    expect(bySignal).toEqual({
      vibration_rms: "AST-SIM-FAN-A",
      current: "AST-SIM-FAN-A",
      load_percent: "AST-SIM-FAN-A",
      temperature: "AST-SIM-ZONE-1",
      relative_humidity: "AST-SIM-ZONE-1",
      equipment_running: "AST-SIM-FAN-B",
    });
  });

  it("emits the S2 telemetry sequence with correlation and causation preserved", async () => {
    await client.sendHeartbeat("HEALTHY");
    await client.sendTelemetry();
    // S3 appended risk.* events after quality_assessed; the telemetry chain itself is unchanged.
    const history = runtime.bus.history().filter((e) => e.event_type.startsWith("telemetry."));
    expect(history.map((e) => e.event_type)).toEqual([
      "telemetry.received.v1",
      "telemetry.authenticated.v1",
      "telemetry.normalized.v1",
      "telemetry.quality_assessed.v1",
    ]);
    expect(history.map((e) => e.causation_id)).toEqual([
      null,
      history[0]?.event_id,
      history[1]?.event_id,
      history[2]?.event_id,
    ]);
    expect(new Set(history.map((e) => e.correlation_id)).size).toBe(1);
    expect(history.map((e) => e.producer)).toEqual(["api", "api", "worker", "worker"]);
    // a single healthy sample never detects a risk or opens a case
    const all = runtime.bus.history().map((e) => e.event_type as string);
    expect(all).not.toContain("risk.detected.v1");
    expect(all.some((t) => t.startsWith("case."))).toBe(false);
  });

  it("without a prior heartbeat, device health is UNKNOWN and confidence is reduced", async () => {
    await client.sendTelemetry();
    const [obs] = await runtime.observations.list("ORG-SIM-001");
    expect(obs?.quality.deviceHealthy).toBe(false);
    expect(obs?.quality.confidence).toBeLessThan(1);
  });

  it("dedupes an identical device+signal+observedAt arriving in a second packet", async () => {
    await client.sendHeartbeat();
    await client.sendTelemetry();
    const second = await client.sendTelemetry(); // same ManualClock instant, new nonce/seq
    expect(second.status).toBe(202);
    expect(await runtime.observations.list("ORG-SIM-001")).toHaveLength(6);
    clock.advance(10_000);
    await client.sendTelemetry();
    expect(await runtime.observations.list("ORG-SIM-001")).toHaveLength(12);
  });

  it("rejects a replayed packet and emits no extra events", async () => {
    const request = client.buildTelemetryRequest();
    expect((await client.send(request)).status).toBe(202);
    const before = runtime.bus.history().length;
    const replay = await client.send(request);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: { code: "NONCE_REPLAY" } });
    expect(runtime.bus.history()).toHaveLength(before);
  });

  it("rejects a tampered payload", async () => {
    const request = client.buildTelemetryRequest();
    const tampered = new TextEncoder().encode(
      new TextDecoder().decode(request.body).replace("4.", "9."),
    );
    expect(tampered).not.toEqual(request.body);
    const res = await client.send({ ...request, body: tampered });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "SIGNATURE_MISMATCH" } });
    expect(await runtime.observations.list("ORG-SIM-001")).toEqual([]);
    expect(runtime.bus.history()).toEqual([]);
  });

  it("rejects a bad signature (wrong key) without consuming replay state", async () => {
    const bad = makeClient({ key: deviceKeyFromHex("a".repeat(64)), initialSeq: 500 });
    const res = await bad.sendTelemetry();
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "SIGNATURE_MISMATCH" } });
    expect((await client.sendTelemetry()).status).toBe(202); // seq 1 still acceptable
  });

  it("rejects sequence rollback and a stale timestamp over real HTTP", async () => {
    clock.advance(0);
    const high = makeClient({ initialSeq: 100 });
    expect((await high.sendTelemetry()).status).toBe(202);
    const lowSeq = makeClient({ initialSeq: 50 });
    const rollback = await lowSeq.sendTelemetry();
    expect(rollback.status).toBe(409);
    expect(rollback.body).toMatchObject({ error: { code: "SEQUENCE_ROLLBACK" } });

    const stale = makeClient({ initialSeq: 200 });
    const request = stale.buildTelemetryRequest();
    clock.advance(301_000);
    const late = await stale.send(request);
    expect(late.status).toBe(401);
    expect(late.body).toMatchObject({ error: { code: "STALE_TIMESTAMP" } });
  });

  it("rejects an unregistered device", async () => {
    const stranger = new SimulatorClient({
      baseUrl: runtime.server.baseUrl,
      deviceId: "DEV-UNKNOWN-1",
      keyId: "KEY-X",
      key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
      clock,
      initialSeq: 1,
    });
    const res = await stranger.sendTelemetry();
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "UNKNOWN_DEVICE" } });
  });

  it("returns 413 for oversized bodies and keeps serving afterwards", async () => {
    const big = await fetch(`${runtime.server.baseUrl}/edge/v1/telemetry`, {
      method: "POST",
      body: "x".repeat(70 * 1024),
    }).catch(() => undefined);
    if (big !== undefined) expect(big.status).toBe(413);
    expect((await client.sendHeartbeat()).status).toBe(200);
  });
});
