import { describe, expect, it } from "vitest";
import type { EdgeTelemetryPayload } from "@symbiosis/contracts";
import { createEdgeV1Adapter, normalizeTelemetry } from "./index";
import type { NormalizeContext } from "./index";

const hardware = createEdgeV1Adapter({ adapterName: "hw-test", sourceType: "HARDWARE" });
const simulator = createEdgeV1Adapter({ adapterName: "sim-test", sourceType: "SIMULATOR" });

const ctx: NormalizeContext = {
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetId: "AST-1",
  deviceId: "DEV-1",
  expectedSignals: [
    "temperature",
    "relative_humidity",
    "vibration_rms",
    "current",
    "load_percent",
    "equipment_running",
  ],
  receivedAt: "2026-09-29T20:00:05.000Z",
};

const payload = (
  readings: EdgeTelemetryPayload["batch"][number]["readings"],
): EdgeTelemetryPayload => ({
  device_id: "DEV-1",
  firmware_version: "1",
  source: "HARDWARE",
  batch: [{ observed_at: "2026-09-29T20:00:00Z", readings }],
});

const all = {
  temperature_c: 4.2,
  relative_humidity_pct: 55.1,
  vibration_rms_ms2: 0.18,
  current_ma: 312,
  fan_a_load_pct: 100,
  chiller_b_running: false,
};

describe("normalizeTelemetry", () => {
  it("maps each spec section 33 field to its canonical signal, unit and value", () => {
    const { observations, rejectedReadings } = normalizeTelemetry(hardware, payload(all), ctx);
    expect(rejectedReadings).toEqual([]);
    const bySignal = Object.fromEntries(observations.map((o) => [o.signal, o]));
    expect(bySignal.temperature).toMatchObject({ value: 4.2, unit: "degC" });
    expect(bySignal.relative_humidity).toMatchObject({ value: 55.1, unit: "%" });
    expect(bySignal.vibration_rms).toMatchObject({ value: 0.18, unit: "m/s2" });
    expect(bySignal.current).toMatchObject({ unit: "A" });
    expect(bySignal.current?.value).toBeCloseTo(0.312, 6);
    expect(bySignal.load_percent).toMatchObject({ value: 100, unit: "%" });
    expect(bySignal.equipment_running).toMatchObject({ value: false, unit: "boolean" });
    expect(observations).toHaveLength(6);
  });

  it("preserves identity, timestamps, source and adapter on every observation", () => {
    const { observations } = normalizeTelemetry(hardware, payload(all), ctx);
    for (const o of observations) {
      expect(o).toMatchObject({
        organizationId: "ORG-1",
        facilityId: "FAC-1",
        assetId: "AST-1",
        deviceId: "DEV-1",
        observedAt: "2026-09-29T20:00:00.000Z",
        receivedAt: "2026-09-29T20:00:05.000Z",
        sourceType: "HARDWARE",
        sourceAdapter: "hw-test",
      });
      expect(o.observationId).toBe(`OBS-DEV-1-${o.signal}-2026-09-29T20:00:00.000Z`);
      expect("quality" in o).toBe(false);
    }
  });

  it("canonicalizes observed_at so equal instants share one dedupe identity", () => {
    const a = normalizeTelemetry(hardware, payload({ temperature_c: 1 }), ctx);
    const p = payload({ temperature_c: 1 });
    const b = normalizeTelemetry(
      hardware,
      { ...p, batch: [{ ...p.batch[0]!, observed_at: "2026-09-29T20:00:00.000+00:00" }] },
      ctx,
    );
    expect(a.observations[0]?.observedAt).toBe(b.observations[0]?.observedAt);
  });

  it("hardware and simulator packets normalize to the same canonical shape", () => {
    const canonical = (adapter: typeof hardware) =>
      normalizeTelemetry(adapter, payload(all), ctx).observations.map((o) => ({
        ...o,
        sourceType: "X" as const,
        sourceAdapter: "X",
      }));
    expect(canonical(hardware)).toEqual(canonical(simulator));
  });

  it("reports (never silently drops) unmapped fields, type mismatches and unexpected signals", () => {
    const { observations, rejectedReadings } = normalizeTelemetry(
      hardware,
      payload({ mystery_field: 1, chiller_b_running: 1, temperature_c: 3 }),
      { ...ctx, expectedSignals: ["equipment_running"] },
    );
    expect(observations).toEqual([]);
    expect(rejectedReadings.map((r) => [r.field, r.reason]).sort()).toEqual([
      ["chiller_b_running", "VALUE_TYPE_MISMATCH"],
      ["mystery_field", "UNMAPPED_FIELD"],
      ["temperature_c", "SIGNAL_NOT_EXPECTED"],
    ]);
  });

  it("is deterministic and orders fields alphabetically within a sample", () => {
    const a = normalizeTelemetry(hardware, payload(all), ctx);
    const b = normalizeTelemetry(hardware, payload(all), ctx);
    expect(a).toEqual(b);
    expect(a.observations.map((o) => o.signal)).toEqual([
      "equipment_running",
      "current",
      "load_percent",
      "relative_humidity",
      "temperature",
      "vibration_rms",
    ]);
  });

  it("handles multi-sample batches in order", () => {
    const p = payload({ temperature_c: 1 });
    const out = normalizeTelemetry(
      hardware,
      {
        ...p,
        batch: [
          p.batch[0]!,
          { observed_at: "2026-09-29T20:00:10Z", readings: { temperature_c: 2 } },
        ],
      },
      ctx,
    );
    expect(out.observations.map((o) => o.value)).toEqual([1, 2]);
  });
});
