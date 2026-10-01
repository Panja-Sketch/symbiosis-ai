import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineKeyString } from "@symbiosis/contracts";
import type { Baseline, BaselineKey } from "@symbiosis/contracts";
import {
  baselineIdFor,
  learn,
  parseBaselineConfig,
  percentDeviation,
  rebaseline,
  resolveOperatingMode,
  standardDeviation,
  startBaseline,
  zScore,
} from "./index";
import type { BaselineConfig } from "./index";

const config: BaselineConfig = parseBaselineConfig(
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "..", "config", "rules", "baselines.v1.json"),
      "utf8",
    ),
  ),
);

const key: BaselineKey = {
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  assetId: "AST-1",
  signal: "vibration_rms",
  operatingMode: "HIGH_LOAD",
};

const t0 = Date.parse("2026-10-01T00:00:00Z");
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString();

/** Feeds samples at the given offsets (seconds) with the given values; all trusted. */
function feed(
  values: readonly number[],
  spacing: number,
  base: Baseline = startBaseline(key, 1, config),
) {
  let b = base;
  const outcomes: string[] = [];
  values.forEach((v, i) => {
    const r = learn(b, { value: v, observedAt: at(i * spacing), trusted: true }, config);
    b = r.baseline;
    outcomes.push(r.outcome);
  });
  return { baseline: b, outcomes };
}

describe("default configuration", () => {
  it("keeps the spec default: a 2 minute warm-up", () => {
    expect(config.warmUpSeconds).toBe(120);
    expect(config.minObservations).toBeGreaterThanOrEqual(2);
  });

  it("rejects invalid configuration", () => {
    expect(() => parseBaselineConfig({})).toThrow();
    expect(() => parseBaselineConfig({ ...config, warmUpSeconds: 0 })).toThrow();
    expect(() => parseBaselineConfig({ ...config, minObservations: 1 })).toThrow();
    expect(() =>
      parseBaselineConfig({ ...config, baselinedSignals: ["hardware_model"] }),
    ).toThrow();
    expect(() =>
      parseBaselineConfig({
        ...config,
        operatingModes: {
          ...config.operatingModes,
          bands: [
            { name: "A", minInclusive: 5 },
            { name: "B", minInclusive: 5 },
          ],
        },
      }),
    ).toThrow();
  });
});

describe("learning", () => {
  it("starts LEARNING and empty; the window begins at the first trusted sample", () => {
    const b = startBaseline(key, 1, config);
    expect(b).toMatchObject({ status: "LEARNING", observationCount: 0, version: 1 });
    expect(b.learningStartedAt).toBeUndefined();
    const r = learn(b, { value: 1, observedAt: at(500), trusted: true }, config);
    expect(r.baseline.learningStartedAt).toBe(at(500));
    expect(r.outcome).toBe("LEARNED");
  });

  it("is not READY on partial warm-up data (window still open)", () => {
    const { baseline, outcomes } = feed(Array(24).fill(0.18), 5); // last sample at 115 s
    expect(baseline.status).toBe("LEARNING");
    expect(outcomes.every((o) => o === "LEARNED")).toBe(true);
  });

  it("becomes READY when the 120 s window ends with enough observations", () => {
    const { baseline, outcomes } = feed(Array(25).fill(0.18), 5); // last sample at exactly 120 s
    expect(baseline.status).toBe("READY");
    expect(outcomes.at(-1)).toBe("BECAME_READY");
    expect(baseline.readyAt).toBe(at(120));
    expect(baseline.observationCount).toBe(25);
  });

  it("window boundary: 119.9 s is still learning, exactly 120 s completes", () => {
    const early = feed([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 10.9); // 11 intervals -> 119.9 s
    expect(early.baseline.status).toBe("LEARNING");
    const exact = learn(early.baseline, { value: 1, observedAt: at(120), trusted: true }, config);
    expect(exact.baseline.status).toBe("READY");
  });

  it("minimum observations boundary: 12 is READY, 11 is INSUFFICIENT_DATA", () => {
    const base = startBaseline(key, 1, config);
    const enough = [...Array(11).fill(1)].reduce<Baseline>(
      (b, v, i) => learn(b, { value: v, observedAt: at(i), trusted: true }, config).baseline,
      base,
    );
    expect(
      learn(enough, { value: 1, observedAt: at(120), trusted: true }, config).baseline.status,
    ).toBe("READY"); // 12th
    const few = [...Array(10).fill(1)].reduce<Baseline>(
      (b, v, i) => learn(b, { value: v, observedAt: at(i), trusted: true }, config).baseline,
      base,
    );
    const r = learn(few, { value: 1, observedAt: at(120), trusted: true }, config); // 11th
    expect(r.baseline.status).toBe("INSUFFICIENT_DATA");
    expect(r.outcome).toBe("BECAME_INSUFFICIENT_DATA");
  });

  it("INSUFFICIENT_DATA is not a usable baseline and does not recover silently", () => {
    const stuck = feed([1, 1, 1], 60).baseline; // 120 s elapsed with 3 samples
    expect(stuck.status).toBe("INSUFFICIENT_DATA");
    const again = learn(stuck, { value: 1, observedAt: at(300), trusted: true }, config);
    expect(again.outcome).toBe("NOT_LEARNING");
    expect(again.baseline).toBe(stuck);
  });
});

describe("statistics", () => {
  it("computes mean, sample standard deviation, min and max deterministically (Welford)", () => {
    const { baseline } = feed([1, 2, 3, 4, 5], 1);
    expect(baseline.observationCount).toBe(5);
    expect(baseline.mean).toBe(3);
    expect(baseline.min).toBe(1);
    expect(baseline.max).toBe(5);
    expect(standardDeviation(baseline)).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(feed([1, 2, 3, 4, 5], 1).baseline).toEqual(baseline);
  });

  it("standard deviation is 0 for one sample", () => {
    expect(standardDeviation(feed([7], 1).baseline)).toBe(0);
  });

  it("z-score uses the configured floor so constant baselines cannot explode", () => {
    const b = feed(Array(10).fill(0.18), 1).baseline;
    expect(standardDeviation(b)).toBe(0);
    expect(zScore(b, 0.18, config)).toBe(0);
    expect(zScore(b, 0.22, config)).toBeCloseTo(2, 9); // floor 0.02
  });

  it("percent deviation is relative to the mean, and undefined for a non-positive mean", () => {
    const b = feed([100, 100], 1).baseline;
    expect(percentDeviation(b, 108)).toBe(8);
    expect(percentDeviation(b, 90)).toBe(-10);
    expect(percentDeviation(feed([0, 0], 1).baseline, 5)).toBeUndefined();
  });
});

describe("trust, ordering and freezing", () => {
  it("untrusted or non-finite samples never touch a baseline (no contamination)", () => {
    const base = feed([1, 1, 1], 1).baseline;
    for (const sample of [
      { value: 999, observedAt: at(10), trusted: false },
      { value: Number.NaN, observedAt: at(10), trusted: true },
      { value: 5, observedAt: "not-a-time", trusted: true },
    ]) {
      const r = learn(base, sample, config);
      expect(r.outcome).toBe("NOT_TRUSTED");
      expect(r.baseline).toBe(base);
    }
  });

  it("ignores duplicate and out-of-order samples (idempotent reprocessing)", () => {
    const base = feed([1, 2, 3], 10).baseline;
    for (const seconds of [20, 5]) {
      const r = learn(base, { value: 9, observedAt: at(seconds), trusted: true }, config);
      expect(r.outcome).toBe("DUPLICATE_OR_OUT_OF_ORDER");
      expect(r.baseline).toBe(base);
    }
  });

  it("a READY baseline is frozen: abnormal data cannot retrain it", () => {
    const ready = feed(Array(25).fill(0.18), 5).baseline;
    const r = learn(ready, { value: 5, observedAt: at(200), trusted: true }, config);
    expect(r.outcome).toBe("NOT_LEARNING");
    expect(r.baseline).toBe(ready);
    expect(r.baseline.mean).toBeCloseTo(0.18, 12);
  });
});

describe("baseline identity and operating mode", () => {
  it("is isolated per organization, facility, asset, signal and operating mode", () => {
    const variants: BaselineKey[] = [
      { ...key, organizationId: "ORG-2" },
      { ...key, facilityId: "FAC-2" },
      { ...key, assetId: "AST-2" },
      { ...key, signal: "current" },
      { ...key, operatingMode: "LOW_LOAD" },
    ];
    const ids = new Set([key, ...variants].map((k) => baselineIdFor(k, 1)));
    const strings = new Set([key, ...variants].map(baselineKeyString));
    expect(ids.size).toBe(6);
    expect(strings.size).toBe(6);
  });

  it("baselines for different assets/signals/modes hold independent statistics", () => {
    const a = feed(Array(5).fill(1), 1, startBaseline(key, 1, config)).baseline;
    const b = feed(
      Array(5).fill(9),
      1,
      startBaseline({ ...key, operatingMode: "LOW_LOAD" }, 1, config),
    ).baseline;
    expect(a.mean).toBe(1);
    expect(b.mean).toBe(9);
  });

  it("derives the operating mode from load bands (boundaries inclusive at the band minimum)", () => {
    const m = (v: number) => resolveOperatingMode(config, "current", { value: v, trusted: true });
    expect(m(0)).toBe("LOW_LOAD");
    expect(m(49.9)).toBe("LOW_LOAD");
    expect(m(50)).toBe("HIGH_LOAD");
    expect(m(100)).toBe("HIGH_LOAD");
  });

  it("uses the default mode for non-sensitive signals or when no load observation exists", () => {
    expect(resolveOperatingMode(config, "temperature", { value: 100, trusted: true })).toBe(
      "DEFAULT",
    );
    expect(resolveOperatingMode(config, "current", "ABSENT")).toBe("DEFAULT");
  });

  it("cannot establish a mode from an untrusted load (so nothing is learned or evaluated)", () => {
    expect(resolveOperatingMode(config, "current", { value: 100, trusted: false })).toBeUndefined();
  });
});

describe("re-baseline", () => {
  const ready = feed(Array(25).fill(0.18), 5).baseline;

  it("supersedes the active baseline, preserves its history, and starts a new version", () => {
    const r = rebaseline(
      ready,
      { actorId: "U-admin", reason: "Fan replaced", at: at(500) },
      config,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { superseded, fresh, audit } = r.value;
    expect(superseded).toMatchObject({
      status: "SUPERSEDED",
      supersededAt: at(500),
      supersededBy: fresh.baselineId,
      supersededFromStatus: "READY",
      observationCount: 25,
    });
    expect(superseded.mean).toBeCloseTo(0.18, 12);
    expect(fresh).toMatchObject({ status: "LEARNING", version: 2, observationCount: 0 });
    expect(fresh.baselineId).not.toBe(ready.baselineId);
    expect(audit).toEqual({
      action: "REBASELINE",
      key,
      supersededBaselineId: ready.baselineId,
      newBaselineId: fresh.baselineId,
      actorId: "U-admin",
      reason: "Fan replaced",
      at: at(500),
    });
  });

  it("never mutates the original baseline object", () => {
    const snapshot = JSON.stringify(ready);
    rebaseline(ready, { actorId: "U", reason: "r", at: at(1) }, config);
    expect(JSON.stringify(ready)).toBe(snapshot);
    expect(ready.status).toBe("READY");
  });

  it("requires an actor, a reason and a valid time", () => {
    for (const bad of [
      { actorId: "", reason: "r", at: at(1) },
      { actorId: "U", reason: " ", at: at(1) },
      { actorId: "U", reason: "r", at: "later" },
    ]) {
      const r = rebaseline(ready, bad, config);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
  });

  it("cannot re-baseline an already superseded baseline", () => {
    const r = rebaseline(ready, { actorId: "U", reason: "r", at: at(1) }, config);
    if (!r.ok) throw new Error("setup");
    expect(
      rebaseline(r.value.superseded, { actorId: "U", reason: "r", at: at(2) }, config).ok,
    ).toBe(false);
  });

  it("a new baseline can be re-baselined again (versions increment)", () => {
    const first = rebaseline(ready, { actorId: "U", reason: "r", at: at(1) }, config);
    if (!first.ok) throw new Error("setup");
    const second = rebaseline(
      first.value.fresh,
      { actorId: "U", reason: "again", at: at(2) },
      config,
    );
    expect(second.ok && second.value.fresh.version).toBe(3);
  });
});
