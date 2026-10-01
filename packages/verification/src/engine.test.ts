import { describe, expect, it } from "vitest";
import type { VerificationAssessment } from "@symbiosis/contracts";
import { evaluateVerification } from "./engine";
import type { VerificationInput } from "./engine";
import {
  BACKUP,
  DEVICE,
  FAC,
  HEALTHY_QUALITY,
  ORG,
  POLICY,
  PRIMARY,
  T0,
  ZONE,
  baseline,
  healthyDevice,
  iso,
  makeInput,
  observation,
} from "./engine.fixture";
import type { Knobs } from "./engine.fixture";
import { parseVerificationPolicy } from "./policy";
import { validateVerificationAssessment } from "./validate";

function run(knobs: Knobs = {}): VerificationAssessment {
  const r = evaluateVerification(makeInput(knobs));
  if (!r.complete) throw new Error("window was not complete");
  return r.assessment;
}

const criterion = (a: VerificationAssessment, id: string) =>
  [...a.requiredCriteria, ...a.supportingCriteria].find((c) => c.criterionId === id);

describe("verification window", () => {
  it("does not conclude anything before the post-action window is complete", () => {
    const end = T0 + 120_000;
    const r = evaluateVerification(makeInput({ nowMs: end - 1 }));
    expect(r).toEqual({ complete: false, windowEnd: iso(end) });
  });

  it("concludes once the window ends", () => {
    expect(evaluateVerification(makeInput()).complete).toBe(true);
  });
});

describe("V1 successful improvement", () => {
  it("is VERIFIED when every required criterion passes over trusted post-action data", () => {
    const a = run();
    expect(a.result).toBe("VERIFIED");
    expect(a.requiredCriteria.map((c) => c.criterionId).sort()).toEqual([
      "CURRENT",
      "DATA_QUALITY",
      "DEVICE_INTEGRITY",
      "VIBRATION",
    ]);
    expect(a.requiredCriteria.every((c) => c.passed && c.outcome === "PASS")).toBe(true);
    expect(a.dataCompleteness).toBe(1);
    expect(a.telemetryConfidence).toBe(1);
    expect(a.deviceHealthStatus).toBe("HEALTHY");
    expect(a.authIntegrityStatus).toBe("VERIFIED");
    expect(a.reasonCodes?.[0]).toBe("ALL_REQUIRED_CRITERIA_PASSED");
    expect(validateVerificationAssessment(a).ok).toBe(true);
  });

  it("explains each physical criterion with reference, before and observed values", () => {
    const a = run({ vib: () => 0.18 });
    const v = criterion(a, "VIBRATION");
    expect(v).toMatchObject({
      role: "REQUIRED",
      assetId: PRIMARY,
      signal: "vibration_rms",
      metric: "z_score",
      reference: { operatingModes: ["HIGH_LOAD"], mean: 0.18 },
      observed: { mean: 0.18 },
    });
    expect(v?.reference?.baselineIds[0]).toMatch(/^BSL:/);
    expect(v?.evidenceIds?.length).toBeGreaterThan(20);
  });

  it("is deterministic: identical input gives an identical assessment", () => {
    const input = makeInput();
    expect(evaluateVerification(input)).toEqual(evaluateVerification(input));
    expect(JSON.stringify(evaluateVerification(makeInput()))).toBe(
      JSON.stringify(evaluateVerification(makeInput())),
    );
  });

  it("records the pre-action values as the 'before' side", () => {
    const pre = [0, 1, 2, 3, 4].map((i) =>
      observation({ signal: "vibration_rms", value: 0.35, at: T0 - 60_000 + i * 5_000 }),
    );
    const a = run({ extraObservations: pre });
    expect(criterion(a, "VIBRATION")?.before).toMatchObject({ sampleCount: 5, mean: 0.35 });
  });

  it("references only real, typed evidence: observations, baselines, actions, audit, policy, device", () => {
    const r = evaluateVerification(makeInput());
    if (!r.complete) throw new Error("incomplete");
    const kinds = new Set(r.evidenceReferences.map((e) => e.kind));
    expect([...kinds].sort()).toEqual(
      ["ACTION", "AUDIT", "BASELINE", "DEVICE", "OBSERVATION", "POLICY"].sort(),
    );
    expect(r.assessment.evidenceIds).toContain("POLICY:VPOL-COOLING-ELECTRICAL:1");
    expect(r.assessment.evidenceIds).toContain(`DEVICE:${DEVICE}`);
    expect(r.assessment.evidenceIds).toContain("ACT-1");
    expect(r.assessment.evidenceIds).toContain("AUD-000001");
    expect(r.evidenceReferences.length).toBe(r.assessment.evidenceIds.length);
    expect(r.recurrenceWatchEndsAt).toBe(iso(T0 + 120_000 + 3_600_000));
  });
});

describe("VERIFIED requires every prerequisite (each one broken individually)", () => {
  const broken: [string, Knobs, string][] = [
    ["vibration still abnormal", { vib: () => 0.35 }, "NOT_IMPROVING"],
    ["current still abnormal", { cur: () => 0.35 }, "NOT_IMPROVING"],
    ["required vibration signal missing", { vib: () => undefined }, "INCONCLUSIVE"],
    ["required current signal missing", { cur: () => undefined }, "INCONCLUSIVE"],
    ["too few observations", { count: 6, stepSeconds: 20 }, "INCONCLUSIVE"],
    [
      "stale required telemetry",
      { quality: () => ({ stale: true, confidence: 0.5 }) },
      "INCONCLUSIVE",
    ],
    [
      "unauthenticated evidence",
      {
        quality: (s, i) =>
          s === "vibration_rms" && i === 10 ? { authVerified: false, confidence: 0 } : undefined,
      },
      "INCONCLUSIVE",
    ],
    [
      "device unhealthy in the observations",
      { quality: () => ({ deviceHealthy: false, confidence: 0.5 }) },
      "INCONCLUSIVE",
    ],
    [
      "device not healthy in the registry",
      { devices: [{ ...healthyDevice, health: "FAULT" }] },
      "INCONCLUSIVE",
    ],
    ["device disabled", { devices: [{ ...healthyDevice, status: "DISABLED" }] }, "INCONCLUSIVE"],
    ["no registered device", { devices: [] }, "INCONCLUSIVE"],
    [
      "excessive missingness",
      {
        vib: (i) => (i % 2 === 0 ? 0.18 : undefined),
        cur: (i) => (i % 2 === 0 ? 0.312 : undefined),
      },
      "INCONCLUSIVE",
    ],
    [
      "gap in the sustained interval",
      { vib: (i) => (i >= 14 && i <= 20 ? undefined : 0.18) },
      "INCONCLUSIVE",
    ],
    ["no baseline", { snapshotBaselines: [] }, "INCONCLUSIVE"],
    ["low telemetry confidence", { quality: () => ({ confidence: 0.6 }) }, "INCONCLUSIVE"],
  ];

  it.each(broken)("%s never yields VERIFIED", (_name, knobs, expected) => {
    const a = run(knobs);
    expect(a.result).not.toBe("VERIFIED");
    expect(a.result).toBe(expected);
    // the primary decision logic must be right on its own; the validator is only a backstop
    expect(a.reasonCodes?.[0]).not.toBe("ASSESSMENT_FAILED_VALIDATION");
    expect(a.reasonCodes?.[0]).not.toBe("ALL_REQUIRED_CRITERIA_PASSED");
  });

  it("no observations at all is INCONCLUSIVE with zero completeness (never VERIFIED)", () => {
    const a = run({ vib: () => undefined, cur: () => undefined, load: () => undefined });
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.dataCompleteness).toBe(0);
    expect(a.confidence).toBe(0);
    expect(a.authIntegrityStatus).toBe("NO_EVIDENCE");
  });

  it("a VERIFIED outcome that fails validation is downgraded, never emitted", () => {
    const input = makeInput();
    const r = evaluateVerification({ ...input, event: { ...input.event, eventId: "" } });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).not.toBe("VERIFIED");
  });
});

describe("INCONCLUSIVE vs NOT_IMPROVING", () => {
  it("trusted abnormal evidence is NOT_IMPROVING, with the reason", () => {
    const a = run({ vib: () => 0.35, cur: () => 0.35 });
    expect(a.result).toBe("NOT_IMPROVING");
    expect(a.reasonCodes).toContain("VIBRATION:STILL_MATERIALLY_ABNORMAL");
    expect(a.reasonCodes).toContain("CURRENT:STILL_MATERIALLY_ABNORMAL");
  });

  it("missing evidence is INCONCLUSIVE and is not converted to NOT_IMPROVING or VERIFIED", () => {
    const a = run({ vib: () => undefined, cur: () => undefined });
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.reasonCodes).toContain("VIBRATION:REQUIRED_SIGNAL_MISSING");
  });

  it("untrustworthy abnormal-looking evidence is INCONCLUSIVE, not NOT_IMPROVING", () => {
    const a = run({
      vib: () => 0.35,
      cur: () => 0.35,
      quality: () => ({ authVerified: false, confidence: 0 }),
    });
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.reasonCodes).toContain("DEVICE_INTEGRITY:UNAUTHENTICATED_EVIDENCE_PRESENT");
  });

  it("trusted vibration proof of non-improvement stands even if current data is missing", () => {
    const a = run({ vib: () => 0.35, cur: () => undefined });
    expect(a.result).toBe("NOT_IMPROVING");
    expect(a.dataCompleteness).toBe(0);
  });

  it("an unhealthy registry device blocks even abnormal-looking data from being conclusive", () => {
    const a = run({ vib: () => 0.35, devices: [{ ...healthyDevice, health: "DEGRADED" }] });
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.deviceHealthStatus).toBe("NOT_HEALTHY");
  });

  it("stale data explains itself", () => {
    const a = run({ quality: () => ({ stale: true, confidence: 0.5 }) });
    expect(a.reasonCodes?.some((r) => r.endsWith("STALE_REQUIRED_TELEMETRY"))).toBe(true);
  });

  it("a high average confidence cannot compensate for a missing required signal", () => {
    const a = run({ cur: () => undefined });
    expect(a.telemetryConfidence).toBe(0);
    expect(a.dataCompleteness).toBe(0);
    expect(a.result).not.toBe("VERIFIED");
  });
});

describe("PARTIALLY_VERIFIED (V4)", () => {
  it("is 'improved but not at target': in the tolerance band, no longer materially abnormal", () => {
    const a = run({ vib: () => 0.215 }); // z = 1.75, between 1 (target) and 2 (abnormal)
    expect(a.result).toBe("PARTIALLY_VERIFIED");
    expect(criterion(a, "VIBRATION")?.reasonCodes).toContain("IMPROVED_BUT_NOT_AT_TARGET");
    expect(a.reasonCodes?.[0]).toBe("PARTIAL_IMPROVEMENT_NOT_AT_TARGET");
  });

  it("requires partial to be enabled by the policy; otherwise the target was not met", () => {
    const policy = { ...POLICY, partial: { enabled: false } };
    expect(run({ vib: () => 0.215, policy }).result).toBe("NOT_IMPROVING");
  });

  it("is not a fallback for missing or untrusted data", () => {
    expect(run({ vib: () => undefined }).result).toBe("INCONCLUSIVE");
    expect(run({ quality: () => ({ stale: true, confidence: 0.5 }) }).result).toBe("INCONCLUSIVE");
  });

  it("a still-abnormal required signal outweighs a partial one", () => {
    const a = run({ vib: () => 0.215, cur: () => 0.35 });
    expect(a.result).toBe("NOT_IMPROVING");
  });

  it("hysteresis: a few abnormal samples inside the sustained interval are tolerated up to the limit", () => {
    // 1 of 13 tail samples abnormal (7.7% <= 10%) but only 12/13 on target (92% >= 90%) => PASS
    const a = run({ vib: (i) => (i === 20 ? 0.35 : 0.18) });
    expect(a.result).toBe("VERIFIED");
    // 2 of 13 abnormal (15%): not on target enough, and > 10% abnormal => still abnormal
    const b = run({ vib: (i) => (i === 20 || i === 22 ? 0.35 : 0.18) });
    expect(b.result).toBe("NOT_IMPROVING");
  });
});

describe("backup capacity", () => {
  const startBackup = { actionLibraryIds: ["ACT-COOLING-START-BACKUP"] };

  it("is not a criterion unless the reported action path requires it", () => {
    expect(criterion(run(), "BACKUP_CAPACITY")).toBeUndefined();
  });

  it("is required for the start-backup action and passes only when observed running", () => {
    const a = run({ ...startBackup, backup: () => true });
    expect(criterion(a, "BACKUP_CAPACITY")).toMatchObject({
      role: "REQUIRED",
      outcome: "PASS",
      assetId: BACKUP,
    });
    expect(a.result).toBe("VERIFIED");
  });

  it("a report that backup was started is not proof: not observed running => NOT_IMPROVING", () => {
    const a = run({ ...startBackup, backup: () => false });
    expect(a.result).toBe("NOT_IMPROVING");
    expect(a.reasonCodes).toContain("BACKUP_CAPACITY:BACKUP_NOT_OBSERVED_RUNNING");
  });

  it("no observation of the backup state is INCONCLUSIVE, never VERIFIED", () => {
    const a = run(startBackup);
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.reasonCodes).toContain("BACKUP_CAPACITY:REQUIRED_SIGNAL_MISSING");
  });
});

describe("zone temperature role is configurable", () => {
  const rising = (i: number) => 4 + i * 0.1;
  const falling = (i: number) => 6 - i * 0.05;

  it("is supporting by default: a rising zone does not block VERIFIED", () => {
    const a = run({ zone: rising });
    expect(a.result).toBe("VERIFIED");
    expect(a.supportingCriteria.map((c) => c.criterionId)).toEqual(["ZONE_TEMPERATURE_SLOPE"]);
    expect(criterion(a, "ZONE_TEMPERATURE_SLOPE")?.outcome).toBe("FAIL");
  });

  it("a falling zone passes as supporting evidence", () => {
    expect(criterion(run({ zone: falling }), "ZONE_TEMPERATURE_SLOPE")?.outcome).toBe("PASS");
  });

  it("when configured as required, a rising zone is NOT_IMPROVING and missing data INCONCLUSIVE", () => {
    const policy = {
      ...POLICY,
      criteria: {
        ...POLICY.criteria,
        zoneTemperature: { ...POLICY.criteria.zoneTemperature, role: "REQUIRED" as const },
      },
    };
    expect(run({ policy, zone: rising }).result).toBe("NOT_IMPROVING");
    expect(run({ policy }).result).toBe("INCONCLUSIVE");
    expect(run({ policy, zone: falling }).result).toBe("VERIFIED");
  });
});

describe("operating-mode baselines", () => {
  it("never judges against a different mode's baseline", () => {
    // post-action load is low, but only a HIGH_LOAD baseline exists
    const a = run({ load: () => 20 });
    expect(a.result).toBe("INCONCLUSIVE");
    expect(a.reasonCodes?.some((r) => r.includes("NO_BASELINE_FOR_MODE:LOW_LOAD"))).toBe(true);
  });

  it("uses the baseline of the observed mode when it exists", () => {
    const a = run({
      load: () => 20,
      snapshotBaselines: [
        baseline("vibration_rms", 0.18, { mode: "LOW_LOAD" }),
        baseline("current", 0.312, { mode: "LOW_LOAD" }),
      ],
    });
    expect(a.result).toBe("VERIFIED");
    expect(criterion(a, "VIBRATION")?.reference?.operatingModes).toEqual(["LOW_LOAD"]);
  });

  it("falls back to the active baseline of the SAME mode when the snapshot lacks it", () => {
    const a = run({
      snapshotBaselines: [],
      activeBaselines: [baseline("vibration_rms", 0.18), baseline("current", 0.312)],
    });
    expect(a.result).toBe("VERIFIED");
  });

  it("a load reading that is untrusted makes the operating mode unknown: INCONCLUSIVE", () => {
    const a = run({
      quality: (s) => (s === "load_percent" ? { authVerified: false, confidence: 0 } : undefined),
    });
    expect(a.result).toBe("INCONCLUSIVE");
  });

  it("a baseline that is not READY is not a reference", () => {
    const a = run({
      snapshotBaselines: [
        baseline("vibration_rms", 0.18, { status: "LEARNING" }),
        baseline("current", 0.312),
      ],
    });
    expect(a.result).toBe("INCONCLUSIVE");
  });
});

describe("evidence selection and scope", () => {
  it("cross-tenant observations never contribute", () => {
    const foreign = makeInput();
    const others = foreign.observations.map((o) => ({ ...o, organizationId: "ORG-OTHER" }));
    const r = evaluateVerification({ ...foreign, observations: others });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).toBe("INCONCLUSIVE");
    expect(r.assessment.evidenceIds.some((id) => id.startsWith("OBS-"))).toBe(false);
  });

  it("a trusted foreign copy cannot rescue a case whose own data is missing", () => {
    const input = makeInput({ vib: () => undefined });
    const foreign = makeInput().observations.map((o) => ({ ...o, organizationId: "ORG-OTHER" }));
    const r = evaluateVerification({ ...input, observations: [...input.observations, ...foreign] });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).toBe("INCONCLUSIVE");
  });

  it("other facilities and unrelated assets never contribute", () => {
    const input = makeInput({ vib: () => undefined });
    const otherFacility = makeInput().observations.map((o) => ({ ...o, facilityId: "FAC-OTHER" }));
    const otherAsset = makeInput().observations.map((o) => ({ ...o, assetId: "AST-UNRELATED" }));
    const r = evaluateVerification({
      ...input,
      observations: [...input.observations, ...otherFacility, ...otherAsset],
    });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).toBe("INCONCLUSIVE");
  });

  it("observations outside the post-action window are ignored", () => {
    const input = makeInput({ vib: () => undefined });
    const early = Array.from({ length: 25 }, (_, i) =>
      observation({ signal: "vibration_rms", value: 0.18, at: T0 - 200_000 + i * 5_000 }),
    );
    const late = Array.from({ length: 25 }, (_, i) =>
      observation({ signal: "vibration_rms", value: 0.18, at: T0 + 121_000 + i * 5_000 }),
    );
    const r = evaluateVerification({
      ...input,
      observations: [...input.observations, ...early, ...late],
    });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).toBe("INCONCLUSIVE");
  });

  it("an observation from a device not bound to the asset is excluded", () => {
    const a = run({ devices: [{ ...healthyDevice, assetIds: [BACKUP, ZONE] }] });
    expect(a.result).toBe("INCONCLUSIVE");
  });

  it("an observation from an unregistered device identity is excluded", () => {
    const input = makeInput();
    const spoofed = input.observations.map((o) => ({ ...o, deviceId: "DEV-UNKNOWN" }));
    const r = evaluateVerification({ ...input, observations: spoofed });
    if (!r.complete) throw new Error("incomplete");
    expect(r.assessment.result).toBe("INCONCLUSIVE");
  });
});

describe("completeness and confidence", () => {
  it("completeness is the minimum required-signal coverage", () => {
    const a = run({ cur: (i) => (i % 5 === 0 ? undefined : 0.312) }); // 20 of 25 => 0.8
    expect(a.dataCompleteness).toBe(0.8);
    expect(a.result).toBe("VERIFIED");
  });

  it("telemetry confidence is the minimum across required signals of mean trusted confidence", () => {
    const a = run({ quality: (s) => (s === "current" ? { confidence: 0.9 } : undefined) });
    expect(a.telemetryConfidence).toBe(0.9);
    expect(a.confidence).toBe(0.9);
  });

  it("assessment confidence is completeness x telemetry confidence", () => {
    const a = run({
      cur: (i) => (i % 5 === 0 ? undefined : 0.312),
      quality: () => ({ confidence: 0.9 }),
    });
    expect(a.confidence).toBe(Math.round(0.8 * 0.9 * 10_000) / 10_000);
  });
});

describe("policy parsing fails closed", () => {
  const good = () => JSON.parse(JSON.stringify(POLICY)) as ReturnType<typeof JSON.parse>;

  it("parses the shipped hero policy with the expected identity", () => {
    expect(POLICY).toMatchObject({
      policyId: "VPOL-COOLING-ELECTRICAL",
      policyVersion: "1",
      recurrenceWatch: { seconds: 3600 },
    });
    expect(POLICY.criteria.vibration.role).toBe("REQUIRED");
    expect(POLICY.criteria.current.role).toBe("REQUIRED");
  });

  it("rejects unsupported schema versions and malformed content", () => {
    expect(() => parseVerificationPolicy({ ...good(), schema: "verification-policy.v2" })).toThrow(
      /unsupported/,
    );
    expect(() => parseVerificationPolicy(null)).toThrow();
    expect(() => parseVerificationPolicy({})).toThrow();
    const bad = good();
    bad.sustained.seconds = 9999;
    expect(() => parseVerificationPolicy(bad)).toThrow(/sustained/);
  });

  it("rejects weakened integrity requirements and non-required vibration or current", () => {
    const a = good();
    a.integrity.requireAuthenticated = false;
    expect(() => parseVerificationPolicy(a)).toThrow();
    const b = good();
    b.integrity.requiredDeviceHealth = "UNKNOWN";
    expect(() => parseVerificationPolicy(b)).toThrow();
    const c = good();
    c.criteria.vibration.role = "SUPPORTING";
    expect(() => parseVerificationPolicy(c)).toThrow(/REQUIRED/);
  });

  it("rejects an inverted hysteresis band", () => {
    const a = good();
    a.criteria.current.abnormalMin = a.criteria.current.targetMax;
    expect(() => parseVerificationPolicy(a)).toThrow();
  });
});

describe("assessment validation of criterion outcomes", () => {
  it("rejects a criterion whose passed flag disagrees with its outcome", () => {
    const a = run();
    const forged: VerificationAssessment = {
      ...a,
      requiredCriteria: a.requiredCriteria.map((c) =>
        c.criterionId === "VIBRATION" ? { ...c, passed: true, outcome: "FAIL" as const } : c,
      ),
    };
    expect(validateVerificationAssessment(forged).ok).toBe(false);
  });
});

describe("tenant sanity of fixtures", () => {
  it("fixture constants line up", () => {
    expect([ORG, FAC, HEALTHY_QUALITY.authVerified]).toEqual(["ORG-SIM-001", "FAC-SIM-001", true]);
  });
});

export type { VerificationInput };
