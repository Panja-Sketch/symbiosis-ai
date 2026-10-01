import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { UnassessedObservation } from "@symbiosis/contracts";
import { assessObservation, parseDataQualityConfig } from "./index";

const config = parseDataQualityConfig(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "config", "rules", "data-quality.v1.json"),
      "utf8",
    ),
  ),
);

const obs = (over: Partial<UnassessedObservation> = {}): UnassessedObservation => ({
  observationId: "OBS-1",
  organizationId: "ORG-1",
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
  ...over,
});

const healthy = { deviceHealth: "HEALTHY", authVerified: true } as const;

describe("assessObservation", () => {
  it("gives a fresh, in-range reading from a healthy authenticated device full confidence", () => {
    expect(assessObservation(obs(), healthy, config)).toEqual({
      quality: {
        confidence: 1,
        stale: false,
        outOfRange: false,
        deviceHealthy: true,
        authVerified: true,
      },
      reasons: [],
    });
  });

  it("flags a stale observation and lowers confidence", () => {
    const r = assessObservation(obs({ receivedAt: "2026-09-29T20:05:00.000Z" }), healthy, config);
    expect(r.quality.stale).toBe(true);
    expect(r.quality.confidence).toBe(0.5);
    expect(r.reasons).toEqual(["STALE"]);
  });

  it("treats the exact stale threshold as still fresh", () => {
    const r = assessObservation(obs({ receivedAt: "2026-09-29T20:02:00.000Z" }), healthy, config);
    expect(r.quality.stale).toBe(false);
  });

  it("flags an out-of-range reading with zero confidence", () => {
    const r = assessObservation(obs({ value: 900 }), healthy, config);
    expect(r.quality).toMatchObject({ outOfRange: true, confidence: 0 });
    expect(r.reasons).toContain("OUT_OF_RANGE");
  });

  it.each([
    ["relative_humidity", 101],
    ["load_percent", -1],
    ["vibration_rms", 500],
  ] as const)("range-checks %s=%d", (signal, value) => {
    expect(assessObservation(obs({ signal, value }), healthy, config).quality.outOfRange).toBe(
      true,
    );
  });

  it("flags an unhealthy device and halves confidence", () => {
    const r = assessObservation(obs(), { deviceHealth: "FAULT", authVerified: true }, config);
    expect(r.quality).toMatchObject({ deviceHealthy: false, confidence: 0.5 });
    expect(r.reasons).toEqual(["DEVICE_UNHEALTHY"]);
  });

  it("never treats UNKNOWN device health as healthy", () => {
    const r = assessObservation(obs(), { deviceHealth: "UNKNOWN", authVerified: true }, config);
    expect(r.quality.deviceHealthy).toBe(false);
    expect(r.quality.confidence).toBeLessThan(1);
    expect(r.reasons).toEqual(["DEVICE_HEALTH_UNKNOWN"]);
  });

  it("propagates authentication status and zeroes confidence when unauthenticated", () => {
    const ok = assessObservation(obs(), healthy, config);
    expect(ok.quality.authVerified).toBe(true);
    const bad = assessObservation(obs(), { deviceHealth: "HEALTHY", authVerified: false }, config);
    expect(bad.quality).toMatchObject({ authVerified: false, confidence: 0 });
    expect(bad.reasons).toContain("NOT_AUTHENTICATED");
  });

  it("compounds stale and unhealthy factors", () => {
    const r = assessObservation(
      obs({ receivedAt: "2026-09-29T21:00:00.000Z" }),
      { deviceHealth: "DEGRADED", authVerified: true },
      config,
    );
    expect(r.quality.confidence).toBe(0.25);
  });

  it("does not trust an observation timestamped in the future", () => {
    const r = assessObservation(obs({ observedAt: "2026-09-29T21:00:00.000Z" }), healthy, config);
    expect(r.reasons).toContain("OBSERVED_IN_FUTURE");
    expect(r.quality.confidence).toBe(0);
  });

  it("checks value types: boolean signals need booleans, numeric signals need numbers", () => {
    expect(
      assessObservation(
        obs({ signal: "equipment_running", value: true, unit: "boolean" }),
        healthy,
        config,
      ).quality,
    ).toMatchObject({ outOfRange: false, confidence: 1 });
    expect(
      assessObservation(obs({ signal: "equipment_running", value: 1 }), healthy, config).quality
        .outOfRange,
    ).toBe(true);
    expect(assessObservation(obs({ value: true }), healthy, config).quality.outOfRange).toBe(true);
  });

  it("is deterministic", () => {
    expect(assessObservation(obs(), healthy, config)).toEqual(
      assessObservation(obs(), healthy, config),
    );
  });
});

describe("parseDataQualityConfig", () => {
  it("rejects invalid configuration", () => {
    expect(() => parseDataQualityConfig({})).toThrow();
    expect(() => parseDataQualityConfig({ ...config, staleConfidenceFactor: 2 })).toThrow();
    expect(() =>
      parseDataQualityConfig({ ...config, ranges: { bogus: { min: 0, max: 1 } } }),
    ).toThrow();
    expect(() =>
      parseDataQualityConfig({ ...config, ranges: { temperature: { min: 5, max: 1 } } }),
    ).toThrow();
  });
});
