import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CANONICAL_SIGNALS, observationDedupeKey } from "./canonical";
import { MAX_BATCH_SIZE, parseEdgeHeartbeat, parseEdgeTelemetry } from "./edge";

const samples = join(import.meta.dirname, "..", "..", "..", "firmware-contracts", "sample-packets");
const valid = () => ({
  device_id: "DEV-SIM-001",
  firmware_version: "0.3.0",
  source: "HARDWARE",
  batch: [
    {
      observed_at: "2026-09-29T20:00:00Z",
      readings: { temperature_c: 4.2, chiller_b_running: false },
    },
  ],
});

describe("parseEdgeTelemetry", () => {
  it("accepts the spec section 33 shape", () => {
    expect(parseEdgeTelemetry(valid()).ok).toBe(true);
  });

  it("accepts the committed firmware sample packet", () => {
    const sample = JSON.parse(readFileSync(join(samples, "telemetry.sample.json"), "utf8"));
    expect(parseEdgeTelemetry(sample).ok).toBe(true);
  });

  it.each([null, "x", 42, [], undefined])("rejects a malformed root: %j", (root) => {
    const r = parseEdgeTelemetry(root);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing device_id", () => {
    const rest: Record<string, unknown> = { ...valid() };
    delete rest.device_id;
    const r = parseEdgeTelemetry(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("device_id is required");
  });

  it("rejects an unknown source and missing firmware_version", () => {
    expect(parseEdgeTelemetry({ ...valid(), source: "BMS" }).ok).toBe(false);
    expect(parseEdgeTelemetry({ ...valid(), firmware_version: "" }).ok).toBe(false);
  });

  it("rejects an empty or oversized batch", () => {
    expect(parseEdgeTelemetry({ ...valid(), batch: [] }).ok).toBe(false);
    const big = Array.from({ length: MAX_BATCH_SIZE + 1 }, () => valid().batch[0]);
    expect(parseEdgeTelemetry({ ...valid(), batch: big }).ok).toBe(false);
  });

  it.each(["yesterday", "2026-09-29", "2026-13-40T00:00:00Z", 12345, null])(
    "rejects invalid observed_at %j",
    (observed_at) => {
      const v = valid();
      const r = parseEdgeTelemetry({ ...v, batch: [{ ...v.batch[0], observed_at }] });
      expect(r.ok).toBe(false);
    },
  );

  it.each([
    ["string value", { temperature_c: "4.2" }],
    ["null value", { temperature_c: null }],
    ["object value", { temperature_c: {} }],
    ["array value", { temperature_c: [1] }],
    ["empty readings", {}],
  ])("rejects malformed readings: %s", (_name, readings) => {
    const v = valid();
    expect(parseEdgeTelemetry({ ...v, batch: [{ ...v.batch[0], readings }] }).ok).toBe(false);
  });

  it("rejects non-finite numbers (as produced by non-JSON paths)", () => {
    const v = valid();
    const readings = { temperature_c: Number.POSITIVE_INFINITY };
    expect(parseEdgeTelemetry({ ...v, batch: [{ ...v.batch[0], readings }] }).ok).toBe(false);
  });
});

describe("parseEdgeHeartbeat", () => {
  const hb = {
    device_id: "D",
    firmware_version: "1",
    sent_at: "2026-09-29T20:00:00Z",
    health: "HEALTHY",
  };

  it("accepts a valid heartbeat and the sample packet", () => {
    expect(parseEdgeHeartbeat(hb).ok).toBe(true);
    const sample = JSON.parse(readFileSync(join(samples, "heartbeat.sample.json"), "utf8"));
    expect(parseEdgeHeartbeat(sample).ok).toBe(true);
  });

  it("rejects bad health, bad time and non-objects", () => {
    expect(parseEdgeHeartbeat({ ...hb, health: "UNKNOWN" }).ok).toBe(false);
    expect(parseEdgeHeartbeat({ ...hb, sent_at: "later" }).ok).toBe(false);
    expect(parseEdgeHeartbeat("hb").ok).toBe(false);
  });
});

describe("canonical vocabulary", () => {
  it("matches the architecture signal list exactly", () => {
    expect([...CANONICAL_SIGNALS]).toEqual([
      "temperature",
      "relative_humidity",
      "vibration_rms",
      "current",
      "load_percent",
      "equipment_running",
      "water_presence",
      "flow",
      "outdoor_temperature",
    ]);
  });

  it("builds the device + signal + observed_at dedupe key", () => {
    expect(
      observationDedupeKey({
        deviceId: "D",
        signal: "current",
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe("D|current|2026-01-01T00:00:00.000Z");
  });
});
