import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineKeyString } from "@symbiosis/contracts";
import type {
  Baseline,
  BaselineKey,
  CanonicalObservation,
  CanonicalSignal,
  DetectionState,
  ObservationQuality,
} from "@symbiosis/contracts";
import { learn, parseBaselineConfig, startBaseline } from "@symbiosis/baselines";
import type { BaselineConfig } from "@symbiosis/baselines";
import { emptyDetectionState, evaluateSample, parseRuleConfig } from "./index";
import type { BaselineBook, EvaluateOutput, RuleConfig } from "./index";

const read = (name: string) =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "..", "..", "..", "config", "rules", name), "utf8"),
  );
const bc: BaselineConfig = parseBaselineConfig(read("baselines.v1.json"));
const baseRule: RuleConfig = parseRuleConfig(read("cooling-electrical.v1.json"));

const ORG = "ORG-1";
const FAC = "FAC-1";
const FAN = "AST-FAN";
const ZONE = "AST-ZONE";
const OUT = "AST-OUT";
const t0 = Date.parse("2026-10-01T00:00:00Z");
const at = (s: number) => new Date(t0 + s * 1000).toISOString();

const goodQuality: ObservationQuality = {
  confidence: 1,
  stale: false,
  outOfRange: false,
  deviceHealthy: true,
  authVerified: true,
};

let counter = 0;
function obs(
  signal: CanonicalSignal,
  value: number | boolean,
  seconds: number,
  assetId: string,
  quality: Partial<ObservationQuality> = {},
): CanonicalObservation {
  counter += 1;
  return {
    observationId: `OBS-${counter}`,
    organizationId: ORG,
    facilityId: FAC,
    assetId,
    deviceId: "DEV-1",
    signal,
    value,
    unit: signal === "outdoor_temperature" || signal === "temperature" ? "degC" : "x",
    observedAt: at(seconds),
    receivedAt: at(seconds),
    sourceType: "SIMULATOR",
    sourceAdapter: "test",
    quality: { ...goodQuality, ...quality },
  };
}

type SampleOptions = {
  vib?: number | undefined;
  cur?: number | undefined;
  load?: number | undefined;
  outdoorC?: number | undefined;
  tempC?: number | undefined;
  q?: Partial<ObservationQuality>;
  vibQ?: Partial<ObservationQuality>;
  curQ?: Partial<ObservationQuality>;
  loadQ?: Partial<ObservationQuality>;
};

/** One sample instant, like a telemetry packet. Pass `undefined` to omit a reading. */
function sample(seconds: number, o: SampleOptions = {}): CanonicalObservation[] {
  const has = (k: keyof SampleOptions) => Object.hasOwn(o, k);
  const out: CanonicalObservation[] = [];
  const pick = <T>(k: keyof SampleOptions, dflt: T) => (has(k) ? (o[k] as T | undefined) : dflt);
  const cur = pick("cur", 100);
  const vib = pick("vib", 0.5);
  const load = pick("load", 100);
  const outdoor = pick("outdoorC", 30);
  const temp = pick("tempC", 4);
  if (cur !== undefined) out.push(obs("current", cur, seconds, FAN, { ...o.q, ...o.curQ }));
  if (load !== undefined) out.push(obs("load_percent", load, seconds, FAN, { ...o.q, ...o.loadQ }));
  if (outdoor !== undefined) out.push(obs("outdoor_temperature", outdoor, seconds, OUT, o.q));
  if (temp !== undefined) out.push(obs("temperature", temp, seconds, ZONE, o.q));
  if (vib !== undefined) out.push(obs("vibration_rms", vib, seconds, FAN, { ...o.q, ...o.vibQ }));
  return out;
}

/**
 * Baselines chosen so thresholds land on exact floating-point values:
 * vibration mean 0.5 (stddev floor overridden to 0.25 => z of 1.0 is exactly 2);
 * current mean 100 (108 is exactly +8%).
 */
const exactBc: BaselineConfig = { ...bc, stdDevFloor: { ...bc.stdDevFloor, vibration_rms: 0.25 } };

function ready(signal: CanonicalSignal, mean: number, assetId = FAN, mode = "HIGH_LOAD"): Baseline {
  const key: BaselineKey = {
    organizationId: ORG,
    facilityId: FAC,
    assetId,
    signal,
    operatingMode: mode,
  };
  let b = startBaseline(key, 1, bc);
  for (let i = 0; i <= 24; i++) {
    b = learn(b, { value: mean, observedAt: at(-1000 + i * 5), trusted: true }, bc).baseline;
  }
  expect(b.status).toBe("READY");
  return b;
}

const book = (...bs: Baseline[]): BaselineBook =>
  Object.fromEntries(bs.map((b) => [baselineKeyString(b.key), b]));

const readyBook = () => book(ready("vibration_rms", 0.5), ready("current", 100));

type Run = { out: EvaluateOutput; state: DetectionState; baselines: BaselineBook };

function step(
  prev: Run | undefined,
  observations: CanonicalObservation[],
  opts: { rule?: RuleConfig; bcfg?: BaselineConfig; baselines?: BaselineBook } = {},
): Run {
  const rule = opts.rule ?? baseRule;
  const out = evaluateSample({
    organizationId: ORG,
    facilityId: FAC,
    observations,
    state: prev?.state ?? emptyDetectionState(ORG, FAC, rule.ruleId),
    baselines: prev?.baselines ?? opts.baselines ?? readyBook(),
    rule,
    baselineConfig: opts.bcfg ?? exactBc,
  });
  return { out, state: out.state, baselines: out.baselines };
}

const evalFor = (r: Run, signal: CanonicalSignal) =>
  r.out.evaluations.find((e) => e.signal === signal);

const ABN = { vib: 1.5, cur: 130 }; // z = 4, +30%
const HEAT = { outdoorC: 42 };

describe("rule configuration", () => {
  it("parses the versioned rule and contains the spec v1 thresholds as data", () => {
    expect(baseRule).toMatchObject({
      ruleId: "RULE-COOLING-ELECTRICAL",
      thresholds: { vibrationZ: 2, currentDeviationPercent: 8, outdoorTemperatureDegF: 105 },
    });
    expect(baseRule.thresholds.zoneTemperatureSlopeDegCPerHour).toBe(0);
  });

  it("rejects malformed rule configuration", () => {
    expect(() => parseRuleConfig({})).toThrow();
    expect(() =>
      parseRuleConfig({
        ...baseRule,
        persistence: { minQualifyingEvaluations: 0, maxGapSeconds: 5 },
      }),
    ).toThrow();
    expect(() =>
      parseRuleConfig({ ...baseRule, signals: { ...baseRule.signals, vibration: "chip_x" } }),
    ).toThrow();
    expect(() =>
      parseRuleConfig({ ...baseRule, trust: { minConfidence: 2, requireHealthyDevice: true } }),
    ).toThrow();
  });

  it("source code carries no hard-coded rule thresholds", () => {
    const src = ["evaluate.ts", "config.ts"]
      .map((f) => readFileSync(join(import.meta.dirname, f), "utf8"))
      .join("\n");
    expect(src).not.toMatch(/\b105\b|\b0\.08\b|\b>=\s*2\b/);
  });
});

describe("single abnormal signals are at most WATCH", () => {
  it("normal readings are NORMAL", () => {
    const r = step(undefined, sample(0));
    expect(evalFor(r, "vibration_rms")).toMatchObject({
      outcome: "NORMAL",
      instantOutcome: "NORMAL",
    });
    expect(r.out.detections).toEqual([]);
  });

  it("vibration only is WATCH, never a detection, however long it persists", () => {
    let r: Run | undefined;
    for (let i = 0; i < 10; i++) r = step(r, sample(i * 5, { vib: 1.5, ...HEAT }));
    expect(evalFor(r!, "vibration_rms")).toMatchObject({ outcome: "WATCH" });
    expect(evalFor(r!, "vibration_rms")?.reasonCodes).toContain("SINGLE_SIGNAL_ABNORMAL");
    expect(r!.out.detections).toEqual([]);
  });

  it("current only is WATCH, never a detection", () => {
    let r: Run | undefined;
    for (let i = 0; i < 10; i++) r = step(r, sample(i * 5, { cur: 130, ...HEAT }));
    expect(evalFor(r!, "current")).toMatchObject({ outcome: "WATCH" });
    expect(r!.out.detections).toEqual([]);
  });

  it("context only (heat, normal asset signals) is NORMAL with CONTEXT_ONLY", () => {
    const r = step(undefined, sample(0, HEAT));
    expect(evalFor(r, "vibration_rms")).toMatchObject({ outcome: "NORMAL" });
    expect(r.out.evaluations[0]?.instantOutcome).toBe("NORMAL");
    expect(r.out.detections).toEqual([]);
  });

  it("both abnormal without any context data is WATCH (CONTEXT_NOT_ESTABLISHED), not NORMAL", () => {
    const r = step(undefined, sample(0, { ...ABN, outdoorC: undefined, tempC: undefined }));
    expect(r.out.evaluations[0]?.instantOutcome).toBe("WATCH");
    expect(evalFor(r, "vibration_rms")?.reasonCodes).toContain("CONTEXT_NOT_ESTABLISHED");
  });

  it("both abnormal with context present but not satisfied is WATCH (CONTEXT_NOT_SATISFIED)", () => {
    const r = step(undefined, sample(0, { ...ABN, outdoorC: 30 }));
    expect(evalFor(r, "vibration_rms")).toMatchObject({ outcome: "WATCH" });
    expect(evalFor(r, "vibration_rms")?.reasonCodes).toContain("CONTEXT_NOT_SATISFIED");
  });
});

describe("compound deterioration and persistence", () => {
  const compound = (s: number) => sample(s, { ...ABN, ...HEAT });

  it("flags CANDIDATE_RISK per instant but only detects after N distinct qualifying instants", () => {
    let r = step(undefined, compound(0));
    expect(evalFor(r, "vibration_rms")).toMatchObject({
      outcome: "CANDIDATE_RISK",
      persistence: { qualifyingEvaluations: 1, required: 3 },
    });
    expect(r.out.detections).toEqual([]);
    r = step(r, compound(5));
    expect(r.out.detections).toEqual([]);
    r = step(r, compound(10));
    expect(r.out.detections).toHaveLength(1);
    const d = r.out.detections[0]!;
    expect(d).toMatchObject({
      ruleId: "RULE-COOLING-ELECTRICAL",
      ruleVersion: "1",
      hazardType: "COOLING_ELECTRICAL_DETERIORATION",
      primaryAssetId: FAN,
      contextAssetIds: [OUT],
      detectedAt: at(10),
      persistence: { qualifyingEvaluations: 3, required: 3 },
    });
    expect(d.baselineIds).toHaveLength(2);
    expect(d.metrics.vibrationZ).toBeCloseTo(4, 9);
    expect(d.metrics.currentDeviationPercent).toBeCloseTo(30, 9);
    expect(d.reasonCodes).toContain("PERSISTED_3_OF_3");
    expect(d.detectionId).toBe(`DET-RULE-COOLING-ELECTRICAL-${FAN}-${at(10)}`);
  });

  it("every qualifying instant after the threshold yields a further detection of the same episode", () => {
    let r: Run | undefined;
    const counts: number[] = [];
    for (let i = 0; i < 6; i++) {
      r = step(r, compound(i * 5));
      counts.push(r.out.detections.length);
    }
    expect(counts).toEqual([0, 0, 1, 1, 1, 1]);
  });

  it("an interruption by a normal instant resets the count", () => {
    let r = step(undefined, compound(0));
    r = step(r, compound(5));
    r = step(r, sample(10)); // normal
    r = step(r, compound(15));
    r = step(r, compound(20));
    expect(r.out.detections).toEqual([]);
    r = step(r, compound(25));
    expect(r.out.detections).toHaveLength(1);
  });

  it("a gap longer than maxGapSeconds restarts the count", () => {
    let r = step(undefined, compound(0));
    r = step(r, compound(5));
    r = step(r, compound(5 + 31)); // gap 31 s > 30 s
    expect(evalFor(r, "vibration_rms")?.persistence?.qualifyingEvaluations).toBe(1);
    expect(r.out.detections).toEqual([]);
  });

  it("a gap of exactly maxGapSeconds continues the count", () => {
    let r = step(undefined, compound(0));
    r = step(r, compound(30));
    expect(evalFor(r, "vibration_rms")?.persistence?.qualifyingEvaluations).toBe(2);
  });

  it("re-delivering the same sample neither double counts nor re-detects", () => {
    const s = compound(10);
    let r = step(undefined, compound(0));
    r = step(r, compound(5));
    r = step(r, s);
    expect(r.out.detections).toHaveLength(1);
    const again = step(r, s);
    expect(again.out.detections).toEqual([]);
    expect(again.state.persistence[FAN]?.streak).toBe(3);
  });

  it("an INSUFFICIENT_DATA instant neither counts nor resets the streak", () => {
    let r = step(undefined, compound(0));
    r = step(r, compound(5));
    r = step(r, sample(10, { ...ABN, ...HEAT, vibQ: { stale: true } }));
    expect(r.out.evaluations[0]?.instantOutcome).toBe("INSUFFICIENT_DATA");
    r = step(r, compound(15));
    expect(r.out.detections).toHaveLength(1);
  });

  it("detects through the rising zone-temperature branch (no outdoor heat)", () => {
    let r: Run | undefined;
    for (let i = 0; i < 8; i++) {
      r = step(r, sample(i * 5, { ...ABN, outdoorC: 30, tempC: 4 + 0.1 * i }));
    }
    const all = r!.out.detections;
    expect(all.length).toBeGreaterThan(0);
    expect(all[0]?.reasonCodes).toContain("ZONE_TEMPERATURE_RISING");
    expect(all[0]?.reasonCodes).not.toContain("OUTDOOR_HEAT_CONTEXT");
    expect(all[0]?.contextAssetIds).toEqual([ZONE]);
  });

  it("flat zone temperature is not rising (exclusive slope threshold)", () => {
    let r: Run | undefined;
    for (let i = 0; i < 10; i++) r = step(r, sample(i * 5, { ...ABN, outdoorC: 30, tempC: 4 }));
    expect(r!.out.detections).toEqual([]);
    expect(evalFor(r!, "vibration_rms")?.reasonCodes).toContain("CONTEXT_NOT_SATISFIED");
  });

  it("a flat series never reads as rising through floating-point noise", () => {
    for (const flat of [4.2, 0.1 + 0.2, 4.123456789, 17.3]) {
      let r: Run | undefined;
      for (let i = 0; i < 12; i++) {
        r = step(r, sample(i * 5, { ...ABN, outdoorC: 30, tempC: flat }));
      }
      expect(r!.out.detections, `flat=${flat}`).toEqual([]);
      expect(r!.out.evaluations[0]?.metrics.zoneTemperatureSlopeDegCPerHour).toBe(0);
    }
  });

  it("falling zone temperature is not rising", () => {
    let r: Run | undefined;
    for (let i = 0; i < 10; i++)
      r = step(r, sample(i * 5, { ...ABN, outdoorC: 30, tempC: 4 - 0.1 * i }));
    expect(r!.out.detections).toEqual([]);
  });

  it("a zone slope needs enough samples before it counts as context", () => {
    let r: Run | undefined;
    for (let i = 0; i < 3; i++) r = step(r, sample(i * 5, { ...ABN, outdoorC: 30, tempC: 4 + i }));
    expect(r!.out.detections).toEqual([]); // 3 samples < minSamples (4)
  });
});

describe("severity (configuration driven)", () => {
  const detect = (opts: SampleOptions, rule = baseRule) => {
    let r: Run | undefined;
    for (let i = 0; i < 4; i++) r = step(r, sample(i * 5, opts), { rule });
    return r!.out.detections[0];
  };

  it("is the configured default for a moderate compound condition", () => {
    // z = 2.5 (>= 2, < 4), +10% (>= 8, < 15)
    expect(detect({ vib: 1.125, cur: 110, ...HEAT })?.severity).toBe("MODERATE");
  });

  it("is HIGH when both strength thresholds are met", () => {
    expect(detect({ ...ABN, ...HEAT })?.severity).toBe("HIGH");
  });

  it("is CRITICAL when HIGH and both context branches hold", () => {
    let r: Run | undefined;
    for (let i = 0; i < 8; i++) r = step(r, sample(i * 5, { ...ABN, ...HEAT, tempC: 4 + 0.1 * i }));
    expect(r!.out.detections.at(-1)?.severity).toBe("CRITICAL");
  });

  it("follows configuration: changing severity thresholds changes the result", () => {
    const rule = {
      ...baseRule,
      severity: { ...baseRule.severity, high: { vibrationZ: 9, currentDeviationPercent: 9 } },
    };
    expect(detect({ ...ABN, ...HEAT }, rule)?.severity).toBe("MODERATE");
  });
});

describe("exact thresholds (inclusive/exclusive as configured)", () => {
  const exactRule: RuleConfig = {
    ...baseRule,
    thresholds: { ...baseRule.thresholds, outdoorTemperatureDegF: 104 },
    persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 },
  };
  const run = (opts: SampleOptions) => step(undefined, sample(0, opts), { rule: exactRule });

  it("vibration z exactly at the threshold counts; just below does not", () => {
    expect(evalFor(run({ vib: 1.0, cur: 108, outdoorC: 40 }), "vibration_rms")?.outcome).toBe(
      "CANDIDATE_RISK",
    );
    const below = run({ vib: 0.99, cur: 108, outdoorC: 40 });
    expect(evalFor(below, "vibration_rms")?.outcome).toBe("NORMAL"); // this signal is fine
    expect(below.out.evaluations[0]?.instantOutcome).toBe("WATCH"); // current alone is abnormal
    expect(below.out.detections).toEqual([]);
    expect(run({ vib: 1.0, cur: 108, outdoorC: 40 }).out.evaluations[0]?.metrics.vibrationZ).toBe(
      2,
    );
  });

  it("current deviation exactly +8% counts; below does not", () => {
    expect(run({ vib: 1.0, cur: 108, outdoorC: 40 }).out.detections).toHaveLength(1);
    expect(run({ vib: 1.0, cur: 107.99, outdoorC: 40 }).out.detections).toEqual([]);
  });

  it("only positive current deviation counts (a drop of 8% is not abnormal)", () => {
    expect(run({ vib: 1.0, cur: 92, outdoorC: 40 }).out.detections).toEqual([]);
  });

  it("outdoor temperature exactly at the threshold counts; just below does not", () => {
    expect(run({ vib: 1.0, cur: 108, outdoorC: 40 }).out.detections).toHaveLength(1); // 104.0 F
    expect(run({ vib: 1.0, cur: 108, outdoorC: 39.9 }).out.detections).toEqual([]); // 103.82 F
  });

  it("the spec default of 105 F needs about 40.56 C", () => {
    const dflt = (c: number) =>
      step(undefined, sample(0, { vib: 1.0, cur: 108, outdoorC: c }), {
        rule: {
          ...baseRule,
          persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 },
        },
      }).out.detections.length;
    expect(dflt(40.5)).toBe(0);
    expect(dflt(40.6)).toBe(1);
  });
});

describe("configuration drives behavior", () => {
  const compound = (s: number) => sample(s, { ...ABN, ...HEAT });

  it("raising the vibration z threshold above the observed z removes the detection", () => {
    const rule = { ...baseRule, thresholds: { ...baseRule.thresholds, vibrationZ: 10 } };
    let r: Run | undefined;
    for (let i = 0; i < 6; i++) r = step(r, compound(i * 5), { rule });
    expect(r!.out.detections).toEqual([]);
  });

  it("lowering persistence to 1 detects on the first qualifying instant", () => {
    const rule = {
      ...baseRule,
      persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 },
    };
    expect(step(undefined, compound(0), { rule }).out.detections).toHaveLength(1);
  });

  it("the rule version and id come from configuration", () => {
    const rule = { ...baseRule, ruleId: "RULE-X", ruleVersion: "9" };
    const r = step(undefined, compound(0), { rule });
    expect(r.out.evaluations[0]).toMatchObject({ ruleId: "RULE-X", ruleVersion: "9" });
  });
});

describe("insufficient evidence is never NORMAL", () => {
  it("with no baselines, everything is INSUFFICIENT_DATA and nothing is detected", () => {
    let r: Run | undefined;
    for (let i = 0; i < 6; i++) r = step(r, sample(i * 5, { ...ABN, ...HEAT }), { baselines: {} });
    expect(r!.out.detections).toEqual([]);
    const v = evalFor(r!, "vibration_rms");
    expect(v).toMatchObject({ outcome: "INSUFFICIENT_DATA", instantOutcome: "INSUFFICIENT_DATA" });
    expect(v?.reasonCodes.some((c) => c.startsWith("BASELINE_"))).toBe(true);
  });

  it("a LEARNING baseline is not usable evidence", () => {
    const learning = startBaseline(
      {
        organizationId: ORG,
        facilityId: FAC,
        assetId: FAN,
        signal: "vibration_rms",
        operatingMode: "HIGH_LOAD",
      },
      1,
      bc,
    );
    const r = step(undefined, sample(0, { ...ABN, ...HEAT }), {
      baselines: book(learning, ready("current", 100)),
    });
    expect(evalFor(r, "vibration_rms")?.reasonCodes).toContain("BASELINE_LEARNING:VIBRATION");
    expect(r.out.detections).toEqual([]);
  });

  it("a missing primary signal is INSUFFICIENT_DATA, not NORMAL", () => {
    const r = step(undefined, sample(0, { cur: undefined }));
    expect(r.out.evaluations[0]?.instantOutcome).toBe("INSUFFICIENT_DATA");
    expect(evalFor(r, "vibration_rms")?.outcome).toBe("NORMAL"); // its own value is fine
    expect(r.out.evaluations.every((e) => e.instantOutcome === "INSUFFICIENT_DATA")).toBe(true);
  });

  it("a baseline whose mean is not positive cannot support a current deviation", () => {
    const r = step(undefined, sample(0, ABN), {
      baselines: book(ready("vibration_rms", 0.5), ready("current", 0)),
    });
    expect(evalFor(r, "current")?.reasonCodes).toContain("CURRENT_BASELINE_MEAN_NOT_POSITIVE");
    expect(r.out.detections).toEqual([]);
  });
});

describe("data-quality gate", () => {
  const run = (opts: SampleOptions) =>
    step(undefined, sample(0, { ...ABN, ...HEAT, ...opts }), {
      rule: { ...baseRule, persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 } },
    });

  it("a clean compound sample would detect (control)", () => {
    expect(run({}).out.detections).toHaveLength(1);
  });

  it.each([
    ["stale", { stale: true }, "STALE"],
    ["unauthenticated", { authVerified: false }, "NOT_AUTHENTICATED"],
    ["out of range", { outOfRange: true }, "OUT_OF_RANGE"],
    ["unhealthy device", { deviceHealthy: false }, "DEVICE_NOT_HEALTHY"],
    ["low confidence", { confidence: 0.4 }, "LOW_CONFIDENCE"],
  ] as const)("%s vibration cannot satisfy the rule", (_n, vibQ, reason) => {
    const r = run({ vibQ });
    expect(r.out.detections).toEqual([]);
    const v = evalFor(r, "vibration_rms");
    expect(v?.outcome).toBe("INSUFFICIENT_DATA");
    expect(v?.reasonCodes).toContain(`VIBRATION_NOT_TRUSTED:${reason}`);
  });

  it("untrusted current cannot satisfy the rule either", () => {
    const r = run({ curQ: { authVerified: false } });
    expect(r.out.detections).toEqual([]);
    expect(evalFor(r, "current")?.reasonCodes).toContain("CURRENT_NOT_TRUSTED:NOT_AUTHENTICATED");
  });

  it("untrusted outdoor context cannot supply the heat branch", () => {
    const r = run({ q: {}, outdoorC: 42 });
    expect(r.out.detections).toHaveLength(1);
    const untrusted = step(
      undefined,
      [
        ...sample(0, { ...ABN, outdoorC: undefined }),
        obs("outdoor_temperature", 42, 0, OUT, { authVerified: false }),
      ],
      {
        rule: {
          ...baseRule,
          persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 },
        },
      },
    );
    expect(untrusted.out.detections).toEqual([]);
    expect(evalFor(untrusted, "outdoor_temperature")?.outcome).toBe("INSUFFICIENT_DATA");
  });

  it("outdoor context older than the configured max age is not used", () => {
    const rule = {
      ...baseRule,
      persistence: { ...baseRule.persistence, minQualifyingEvaluations: 1 },
    };
    const old = step(undefined, [obs("outdoor_temperature", 42, 0, OUT)], { rule });
    const r = step(old, sample(61, { ...ABN, outdoorC: undefined }), { rule });
    expect(r.out.detections).toEqual([]);
    const fresh = step(old, sample(60, { ...ABN, outdoorC: undefined }), { rule });
    expect(fresh.out.detections).toHaveLength(1); // exactly at the max age is still usable
  });

  it("unhealthy zone-temperature samples do not feed the slope branch", () => {
    let r: Run | undefined;
    for (let i = 0; i < 8; i++) {
      r = step(
        r,
        sample(i * 5, { ...ABN, outdoorC: 30, tempC: 4 + 0.1 * i, q: {} }).map((o) =>
          o.signal === "temperature"
            ? { ...o, quality: { ...o.quality, deviceHealthy: false } }
            : o,
        ),
      );
    }
    expect(r!.out.detections).toEqual([]);
  });
});

describe("operating mode", () => {
  it("compares current against the baseline for the observed load mode", () => {
    const b = book(
      ready("vibration_rms", 0.5),
      ready("current", 100, FAN, "HIGH_LOAD"),
      ready("current", 20, FAN, "LOW_LOAD"),
      ready("vibration_rms", 0.5, FAN, "LOW_LOAD"),
    );
    // 100 mA is normal at high load but +400% versus the low-load baseline
    const high = step(undefined, sample(0, { cur: 100, load: 100 }), { baselines: b });
    expect(evalFor(high, "current")).toMatchObject({ outcome: "NORMAL" });
    expect(evalFor(high, "current")?.baseline?.operatingMode).toBe("HIGH_LOAD");
    const low = step(undefined, sample(0, { cur: 100, load: 20 }), { baselines: b });
    expect(evalFor(low, "current")).toMatchObject({ outcome: "WATCH" });
    expect(evalFor(low, "current")?.baseline?.operatingMode).toBe("LOW_LOAD");
    expect(evalFor(low, "current")?.metrics.currentDeviationPercent).toBe(400);
  });

  it("a mode without a ready baseline is INSUFFICIENT_DATA, not judged against another mode", () => {
    const r = step(undefined, sample(0, { cur: 100, load: 20 }), { baselines: readyBook() });
    expect(evalFor(r, "current")?.outcome).toBe("INSUFFICIENT_DATA");
    expect(evalFor(r, "current")?.reasonCodes[0]).toMatch(/^BASELINE_/);
  });

  it("an untrusted load reading makes the operating mode unknown", () => {
    const r = step(undefined, sample(0, { loadQ: { authVerified: false } }));
    expect(evalFor(r, "current")?.reasonCodes).toContain("CURRENT_OPERATING_MODE_UNKNOWN");
    expect(evalFor(r, "current")?.outcome).toBe("INSUFFICIENT_DATA");
  });

  it("without any load observation the default mode is used", () => {
    const b = book(
      ready("vibration_rms", 0.5, FAN, "DEFAULT"),
      ready("current", 100, FAN, "DEFAULT"),
    );
    const r = step(undefined, sample(0, { load: undefined }), { baselines: b });
    expect(evalFor(r, "current")).toMatchObject({ outcome: "NORMAL" });
  });
});

describe("baseline learning inside the evaluator", () => {
  const learnSeries = (n: number, mutate?: (i: number) => SampleOptions) => {
    let r: Run | undefined;
    for (let i = 0; i < n; i++) {
      r = step(r, sample(i * 5, { vib: 0.5, cur: 100, ...(mutate?.(i) ?? {}) }), { baselines: {} });
    }
    return r!;
  };

  it("learns from healthy samples and becomes READY at the 2 minute mark", () => {
    const early = learnSeries(24);
    expect(Object.values(early.baselines).every((b) => b.status === "LEARNING")).toBe(true);
    const done = learnSeries(25);
    const vib = Object.values(done.baselines).find((b) => b.key.signal === "vibration_rms");
    expect(vib).toMatchObject({ status: "READY", observationCount: 25 });
    expect(vib?.key.operatingMode).toBe("HIGH_LOAD");
  });

  it("is isolated per asset, signal and mode", () => {
    const done = learnSeries(25);
    const keys = Object.values(done.baselines).map(
      (b) => `${b.key.assetId}/${b.key.signal}/${b.key.operatingMode}`,
    );
    expect(keys.sort()).toEqual([
      `${FAN}/current/HIGH_LOAD`,
      `${FAN}/vibration_rms/HIGH_LOAD`,
      `${ZONE}/temperature/DEFAULT`,
    ]);
  });

  it("poor-quality observations do not contaminate the baseline", () => {
    const done = learnSeries(25, (i) =>
      i % 5 === 0
        ? { vib: 99, vibQ: { stale: true } }
        : i % 7 === 0
          ? { vib: 77, vibQ: { authVerified: false } }
          : {},
    );
    const vib = Object.values(done.baselines).find((b) => b.key.signal === "vibration_rms")!;
    expect(vib.mean).toBe(0.5);
    expect(vib.max).toBe(0.5);
    expect(vib.observationCount).toBeLessThan(25);
  });

  it("returns every changed baseline for persistence, and none when nothing changed", () => {
    const first = learnSeries(1);
    expect(first.out.changedBaselines.length).toBe(3);
    const ready = step(undefined, sample(0), { baselines: readyBook() });
    expect(ready.out.changedBaselines.filter((b) => b.key.signal === "vibration_rms")).toEqual([]);
  });

  it("a READY baseline is never retrained by abnormal data", () => {
    const b = readyBook();
    let r: Run | undefined;
    for (let i = 0; i < 6; i++) r = step(r, sample(i * 5, { ...ABN, ...HEAT }), { baselines: b });
    const vib = Object.values(r!.baselines).find((x) => x.key.signal === "vibration_rms")!;
    expect(vib.mean).toBe(0.5);
    expect(vib.observationCount).toBe(25);
  });
});

describe("determinism and multi-asset isolation", () => {
  it("the same input state and observations always produce the same output", () => {
    const o = sample(0, { ...ABN, ...HEAT });
    const a = evaluateSample({
      organizationId: ORG,
      facilityId: FAC,
      observations: o,
      state: emptyDetectionState(ORG, FAC, baseRule.ruleId),
      baselines: readyBook(),
      rule: baseRule,
      baselineConfig: exactBc,
    });
    const b = evaluateSample({
      organizationId: ORG,
      facilityId: FAC,
      observations: o,
      state: emptyDetectionState(ORG, FAC, baseRule.ruleId),
      baselines: readyBook(),
      rule: baseRule,
      baselineConfig: exactBc,
    });
    expect(a).toEqual(b);
  });

  it("does not mutate its inputs", () => {
    const state = emptyDetectionState(ORG, FAC, baseRule.ruleId);
    const baselines = readyBook();
    const before = JSON.stringify({ state, baselines });
    evaluateSample({
      organizationId: ORG,
      facilityId: FAC,
      observations: sample(0, ABN),
      state,
      baselines,
      rule: baseRule,
      baselineConfig: exactBc,
    });
    expect(JSON.stringify({ state, baselines })).toBe(before);
  });

  it("tracks persistence per primary asset (two fans do not share a streak)", () => {
    const FAN2 = "AST-FAN-2";
    const b = book(
      ready("vibration_rms", 0.5),
      ready("current", 100),
      ready("vibration_rms", 0.5, FAN2),
      ready("current", 100, FAN2),
    );
    const mk = (s: number, abnormalFan2: boolean): CanonicalObservation[] => [
      ...sample(s, { ...ABN, ...HEAT }),
      obs("current", abnormalFan2 ? 130 : 100, s, FAN2),
      obs("load_percent", 100, s, FAN2),
      obs("vibration_rms", abnormalFan2 ? 1.5 : 0.5, s, FAN2),
    ];
    let r: Run | undefined;
    for (let i = 0; i < 3; i++) r = step(r, mk(i * 5, false), { baselines: b });
    expect(r!.out.detections.map((d) => d.primaryAssetId)).toEqual([FAN]);
    expect(r!.state.persistence[FAN2]?.streak).toBe(0);
  });
});
