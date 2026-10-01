import { describe, expect, it } from "vitest";
import { parseEdgeTelemetry } from "@symbiosis/contracts";
import { sourceLabelFor } from "@symbiosis/evidence";
import { normalizeTelemetry } from "@symbiosis/normalization";
import { BENCH_ASSETS, createBenchDeviceRecord, esp32SourceAdapter } from "./index";

/** A body exactly as the S10 firmware serializes it (see firmware/esp32-lab host tests). */
const FIRMWARE_BODY = `{"device_id":"DEV-PHX-BENCH-001","firmware_version":"0.1.0+gabc1234","source":"HARDWARE","batch":[{"observed_at":"2025-12-31T23:59:59Z","readings":{"temperature_c":4.20,"relative_humidity_pct":55.1,"vibration_rms_ms2":0.1800,"current_ma":312.0,"chiller_b_running":true}}]}`;

describe("esp32 source adapter and bench device template", () => {
  const device = createBenchDeviceRecord({
    deviceId: "DEV-PHX-BENCH-001",
    keyId: "KEY-PHX-BENCH-001",
    organizationId: "ORG-SIM-001",
    facilityId: "FAC-SIM-001",
  });
  const parsed = parseEdgeTelemetry(JSON.parse(FIRMWARE_BODY));

  it("a firmware packet is schema-valid and normalizes with no rejected readings", () => {
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { observations, rejectedReadings } = normalizeTelemetry(
      esp32SourceAdapter,
      parsed.value,
      {
        organizationId: device.organizationId,
        facilityId: device.facilityId,
        assetId: device.assetId,
        ...(device.assetMapping !== undefined && { assetMapping: device.assetMapping }),
        deviceId: device.deviceId,
        expectedSignals: device.expectedSignals,
        receivedAt: "2026-01-01T00:00:05.000Z",
      },
    );
    expect(rejectedReadings).toEqual([]);
    expect(observations).toHaveLength(5);
    expect(observations.every((o) => o.sourceType === "HARDWARE")).toBe(true);
    const asset = (signal: string) => observations.find((o) => o.signal === signal)?.assetId;
    expect(asset("vibration_rms")).toBe(BENCH_ASSETS.primary);
    expect(asset("current")).toBe(BENCH_ASSETS.primary);
    expect(asset("temperature")).toBe(BENCH_ASSETS.zone);
    expect(asset("relative_humidity")).toBe(BENCH_ASSETS.zone);
    expect(asset("equipment_running")).toBe(BENCH_ASSETS.backup);
  });

  it("evidence built from these observations is labelled prototype hardware, never synthetic", () => {
    if (!parsed.ok) throw new Error("fixture invalid");
    const { observations } = normalizeTelemetry(esp32SourceAdapter, parsed.value, {
      organizationId: device.organizationId,
      facilityId: device.facilityId,
      assetId: device.assetId,
      deviceId: device.deviceId,
      expectedSignals: device.expectedSignals,
      receivedAt: "2026-01-01T00:00:05.000Z",
    });
    const label = sourceLabelFor(observations);
    expect(label.dataOrigin).toBe("PROTOTYPE_HARDWARE");
    expect(label.synthetic).toBe(false);
    expect(label.sourceAdapters).toEqual(["esp32-edge-v1"]);
  });

  it("the bench template has no load or outdoor signals and starts with unknown health", () => {
    expect(device.expectedSignals).toEqual([
      "temperature",
      "relative_humidity",
      "vibration_rms",
      "current",
      "equipment_running",
    ]);
    expect(device.health).toBe("UNKNOWN");
    expect(device.status).toBe("ACTIVE");
  });
});
