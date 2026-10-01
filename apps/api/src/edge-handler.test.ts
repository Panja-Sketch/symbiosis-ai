import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_KEY_HEX,
  createSyntheticDevRegistry,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { InMemoryReplayGuard, signEdgeRequest } from "@symbiosis/edge-security";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import { createEdgeHandler } from "./edge-handler";
import type { EdgeLogEntry, EdgeRequest } from "./edge-handler";

const NOW = 1_790_000_000;
const KEY = deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX);
const enc = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));

let bus: InMemoryBus;
let registry: ReturnType<typeof createSyntheticDevRegistry>["registry"];
let handle: ReturnType<typeof createEdgeHandler>;
let logs: EdgeLogEntry[];
let seq = 0;

beforeEach(() => {
  const dev = createSyntheticDevRegistry();
  registry = dev.registry;
  bus = new InMemoryBus();
  logs = [];
  seq = 0;
  handle = createEdgeHandler({
    registry,
    keys: dev.keys,
    replayGuard: new InMemoryReplayGuard(),
    bus,
    clock: new ManualClock(NOW * 1000),
    ids: new SequentialIdGenerator(),
    log: (e) => logs.push(e),
  });
});

function signed(path: string, body: Uint8Array, method = "POST"): EdgeRequest {
  const headers = signEdgeRequest({
    key: KEY,
    method,
    path,
    deviceId: "DEV-SIM-001",
    keyId: "KEY-SIM-001",
    timestampSeconds: NOW,
    nonce: `handler_nonce_${String(++seq).padStart(6, "0")}`,
    seq,
    body,
  });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, target: path, headers: lower, rawBody: body };
}

const telemetry = (over: Record<string, unknown> = {}) => ({
  device_id: "DEV-SIM-001",
  firmware_version: "1.2.3",
  source: "SIMULATOR",
  batch: [{ observed_at: "2026-09-22T00:00:00Z", readings: { temperature_c: 4.2 } }],
  ...over,
});

describe("edge handler: telemetry", () => {
  it("accepts a valid signed packet, emits received then authenticated, and updates last-seen", async () => {
    const res = await handle(signed("/edge/v1/telemetry", enc(telemetry())));
    expect(res.status).toBe(202);
    expect(bus.history().map((e) => e.event_type)).toEqual([
      "telemetry.received.v1",
      "telemetry.authenticated.v1",
    ]);
    const [received, authenticated] = bus.history();
    expect(received?.causation_id).toBeNull();
    expect(authenticated?.causation_id).toBe(received?.event_id);
    expect(received?.correlation_id).toBe(authenticated?.correlation_id);
    const device = await registry.get("DEV-SIM-001");
    expect(device?.lastSeenAt).toBeDefined();
    expect(device?.firmwareVersion).toBe("1.2.3");
  });

  it("hashes the raw bytes: whitespace-formatted JSON is accepted when those exact bytes were signed", async () => {
    const pretty = JSON.stringify(telemetry(), null, 4);
    const res = await handle(signed("/edge/v1/telemetry", enc(pretty)));
    expect(res.status).toBe(202);
  });

  it("rejects bytes that differ from what was signed even if the JSON is semantically equal", async () => {
    const original = signed("/edge/v1/telemetry", enc(telemetry()));
    const reformatted = enc(JSON.stringify(telemetry(), null, 2));
    const res = await handle({ ...original, rawBody: reformatted });
    expect(res.status).toBe(401);
    expect(bus.history()).toEqual([]);
  });

  it("emits no events for unauthenticated or rejected requests", async () => {
    const req = signed("/edge/v1/telemetry", enc(telemetry()));
    expect(
      (await handle({ ...req, headers: { ...req.headers, "x-signature": "0".repeat(64) } })).status,
    ).toBe(401);
    expect(bus.history()).toEqual([]);
  });

  it("returns 409 for a replayed request and emits events only once", async () => {
    const req = signed("/edge/v1/telemetry", enc(telemetry()));
    expect((await handle(req)).status).toBe(202);
    const replay = await handle(req);
    expect(replay.status).toBe(409);
    expect(replay.body).toMatchObject({ error: { code: "NONCE_REPLAY" } });
    expect(bus.history()).toHaveLength(2);
  });

  it("rejects an authenticated but schema-invalid payload with 400 and no events", async () => {
    const res = await handle(signed("/edge/v1/telemetry", enc(telemetry({ batch: [] }))));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "INVALID_PAYLOAD" } });
    expect(bus.history()).toEqual([]);
  });

  it("rejects an authenticated body that is not valid JSON", async () => {
    const res = await handle(signed("/edge/v1/telemetry", enc("{not json")));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "MALFORMED_BODY" } });
  });

  it("rejects a body device_id that differs from the authenticated device", async () => {
    const res = await handle(
      signed("/edge/v1/telemetry", enc(telemetry({ device_id: "DEV-OTHER" }))),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: { code: "DEVICE_ID_MISMATCH" } });
  });

  it("carries registry device health (UNKNOWN until a heartbeat) into the authenticated event", async () => {
    await handle(signed("/edge/v1/telemetry", enc(telemetry())));
    const event = bus.history()[1];
    if (event?.event_type !== "telemetry.authenticated.v1") throw new Error("wrong event");
    expect(event.payload.deviceHealth).toBe("UNKNOWN");
    expect(event.payload.assetId).toBe("AST-SIM-FAN-A");
    expect(event.payload.expectedSignals).toContain("vibration_rms");
  });
});

describe("edge handler: heartbeat", () => {
  const hb = (health = "HEALTHY") => ({
    device_id: "DEV-SIM-001",
    firmware_version: "2.0.0",
    sent_at: "2026-09-22T00:00:00Z",
    health,
  });

  it("authenticates, updates last-seen, firmware and health, and emits no telemetry events", async () => {
    const res = await handle(signed("/edge/v1/heartbeat", enc(hb("DEGRADED"))));
    expect(res.status).toBe(200);
    const device = await registry.get("DEV-SIM-001");
    expect(device).toMatchObject({ health: "DEGRADED", firmwareVersion: "2.0.0" });
    expect(device?.lastSeenAt).toBeDefined();
    expect(bus.history()).toEqual([]);
  });

  it("subsequent telemetry reflects the reported health", async () => {
    await handle(signed("/edge/v1/heartbeat", enc(hb("HEALTHY"))));
    await handle(signed("/edge/v1/telemetry", enc(telemetry())));
    const event = bus.history()[1];
    if (event?.event_type !== "telemetry.authenticated.v1") throw new Error("wrong event");
    expect(event.payload.deviceHealth).toBe("HEALTHY");
  });

  it("applies the same signature and replay rules", async () => {
    const req = signed("/edge/v1/heartbeat", enc(hb()));
    expect((await handle({ ...req, rawBody: enc(hb("FAULT")) })).status).toBe(401);
    expect((await handle(req)).status).toBe(200);
    expect((await handle(req)).status).toBe(409);
  });

  it("rejects an invalid heartbeat and a mismatched device id", async () => {
    expect(
      (await handle(signed("/edge/v1/heartbeat", enc({ ...hb(), health: "WEIRD" })))).status,
    ).toBe(400);
    expect(
      (await handle(signed("/edge/v1/heartbeat", enc({ ...hb(), device_id: "DEV-X" })))).status,
    ).toBe(403);
  });
});

describe("edge handler: routing and logging", () => {
  it("returns 404 for unknown paths and 405 for non-POST", async () => {
    expect(
      (await handle({ ...signed("/edge/v1/telemetry", enc({})), target: "/edge/v2/x" })).status,
    ).toBe(404);
    expect((await handle(signed("/edge/v1/telemetry", enc({}), "GET"))).status).toBe(405);
  });

  it("rejects query strings because they would be unsigned", async () => {
    const req = signed("/edge/v1/telemetry", enc(telemetry()));
    expect((await handle({ ...req, target: "/edge/v1/telemetry?x=1" })).status).toBe(400);
  });

  it("never logs keys, signatures or bodies", async () => {
    const req = signed("/edge/v1/telemetry", enc(telemetry()));
    await handle({ ...req, headers: { ...req.headers, "x-signature": "0".repeat(64) } });
    await handle(req);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SYNTHETIC_DEV_KEY_HEX);
    expect(text).not.toContain(req.headers["x-signature"] as string);
    expect(text).not.toContain("0".repeat(64));
    expect(text).not.toContain("temperature_c");
    expect(logs.length).toBeGreaterThan(0);
  });
});
