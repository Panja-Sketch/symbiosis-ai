import { describe, expect, it } from "vitest";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import {
  loadEscalationPolicy,
  loadPolicyParameters,
  loadRawPolicyBase,
  loadRuleConfig,
  loadVerificationPolicy,
} from "./config";
import {
  buildPolicyBundle,
  checkPolicyValues,
  createSimulationPolicies,
  defaultValues,
  parsePolicyParameters,
} from "./simulation-policy";

const parameters = loadPolicyParameters();
const rawBase = loadRawPolicyBase();
const defaults = defaultValues(parameters);
const ORG = "ORG-SIM-001";
const FAC = "FAC-SIM-PHX-01";

function make() {
  const clock = new ManualClock(Date.parse("2026-10-02T10:00:00Z"));
  const audit = new InMemoryAuditLog();
  const store = new InMemoryTenantDocumentStore();
  const policies = createSimulationPolicies({
    clock,
    ids: new SequentialIdGenerator(),
    store,
    audit,
    organizationId: ORG,
    facilityId: FAC,
    parameters,
    rawBase,
  });
  return { clock, audit, store, policies };
}
const withValues = (over: Record<string, number>) => ({ ...defaults, ...over });

describe("DEMO / SIMULATION POLICY parameters", () => {
  it("every parameter is bounded, has a default inside the bounds and a unit", () => {
    expect(parameters.label).toBe("DEMO / SIMULATION POLICY");
    expect(parameters.parameters.length).toBeGreaterThan(20);
    for (const p of parameters.parameters) {
      expect(p.min).toBeLessThan(p.max);
      expect(p.default).toBeGreaterThanOrEqual(p.min);
      expect(p.default).toBeLessThanOrEqual(p.max);
      expect(p.unit.length).toBeGreaterThan(0);
    }
  });

  it("the defaults build under the production parsers and leave production files untouched", () => {
    const b = buildPolicyBundle(rawBase, parameters, defaults, 1);
    expect(b.rule.ruleVersion).toBe("sim.1");
    expect(b.verification.policyVersion).toBe("sim.1");
    expect(b.rule.ruleId).toBe(loadRuleConfig().ruleId);
    // production is unchanged
    expect(loadRuleConfig().ruleVersion).toBe("1");
    expect(loadRuleConfig().contextMaxAgeSeconds).toBe(60);
    expect(loadVerificationPolicy().postActionWindow.durationSeconds).toBe(120);
    expect(loadEscalationPolicy().acknowledgementDeadlineSeconds.MODERATE).toBe(900);
    // the simulation version is the demonstration variant: weather-compatible context, shorter windows
    expect(b.rule.contextMaxAgeSeconds).toBe(2700);
    expect(b.verification.postActionWindow.durationSeconds).toBe(60);
    expect(b.dataQuality.staleAfterSecondsBySignal?.outdoor_temperature).toBe(3600);
    expect(b.baseline.warmUpSeconds).toBe(60);
  });

  it("rejects malformed parameter files", () => {
    expect(() => parsePolicyParameters({ schema: "x", parameters: [] })).toThrow();
    const raw = JSON.parse(
      JSON.stringify({
        schema: "simulation-policy.v1",
        label: "L",
        note: "n",
        parameters: parameters.parameters,
      }),
    );
    raw.parameters[0].default = 999;
    expect(() => parsePolicyParameters(raw)).toThrow(/bounds/);
  });
});

describe("value validation", () => {
  const issues = (v: unknown) => checkPolicyValues(parameters, v, rawBase);

  it("accepts the defaults and every boundary value", () => {
    expect(issues(defaults)).toEqual([]);
    expect(issues(withValues({ "rule.vibrationZ": 1 }))).toEqual([]);
    expect(issues(withValues({ "rule.vibrationZ": 4 }))).toEqual([]); // equal to the HIGH level is fine
  });

  it("refuses out-of-range, non-numeric, fractional-integer, unknown and missing values with reasons", () => {
    expect(issues(withValues({ "rule.vibrationZ": 0.9 })).join()).toMatch(/between 1 and 6/);
    expect(issues(withValues({ "rule.vibrationZ": 6.1 })).length).toBeGreaterThan(0);
    expect(issues(withValues({ "rule.vibrationZ": Number.NaN })).join()).toMatch(/finite number/);
    expect(issues({ ...defaults, "rule.vibrationZ": "2" }).join()).toMatch(/finite number/);
    expect(issues(withValues({ "rule.persistence": 2.5 })).join()).toMatch(/whole number/);
    expect(issues({ ...defaults, "rule.nonsense": 1 }).join()).toMatch(/unknown setting/);
    const missing: Record<string, unknown> = { ...defaults };
    delete missing["rule.vibrationZ"];
    expect(issues(missing).join()).toMatch(/required/);
    expect(issues(null)).not.toEqual([]);
    expect(issues([])).not.toEqual([]);
  });

  it("refuses combinations that cannot work", () => {
    expect(
      issues(
        withValues({
          "verification.sustainedSeconds": 120,
          "verification.postActionWindowSeconds": 60,
        }),
      ).join(),
    ).toMatch(/sustained interval/);
    expect(
      issues(
        withValues({
          "verification.minObservations": 60,
          "verification.postActionWindowSeconds": 60,
        }),
      ).join(),
    ).toMatch(/cannot be reached/);
    expect(
      issues(withValues({ "baseline.minObservations": 60, "baseline.warmUpSeconds": 60 })).join(),
    ).toMatch(/Baseline minimum/);
    expect(
      issues(
        withValues({
          "rule.contextMaxAgeSeconds": 7200,
          "dataQuality.outdoorStaleAfterSeconds": 3600,
        }),
      ).join(),
    ).toMatch(/Context freshness/);
    expect(issues(withValues({ "rule.currentDeviationPercent": 20 })).join()).toMatch(
      /HIGH-severity/,
    );
  });
});

describe("versioning: immutable history, audit, roll back", () => {
  it("starts at the built-in version 1", async () => {
    const { policies } = make();
    const v = await policies.view();
    expect(v.active).toMatchObject({ version: 1, label: "sim.1", builtin: true });
    expect(v.versions).toHaveLength(1);
    expect((await policies.active()).label).toBe("sim.1");
  });

  it("publishes a new version with actor, time and reason, applies it, and never overwrites the old one", async () => {
    const { policies, audit, clock } = make();
    const r = await policies.publish(
      "USR-ORG-ADMIN-001",
      withValues({ "rule.vibrationZ": 3, "rule.persistence": 2 }),
      "Be stricter about vibration",
    );
    expect(r).toEqual({ ok: true, version: 2 });
    clock.advance(3000); // the active-policy cache is a couple of seconds
    const active = await policies.active();
    expect(active.label).toBe("sim.2");
    expect(active.rule.thresholds.vibrationZ).toBe(3);
    expect(active.rule.persistence.minQualifyingEvaluations).toBe(2);
    expect(active.rule.ruleVersion).toBe("sim.2");
    // version 1 is still exactly what it was
    const v1 = await policies.bundleFor(1);
    expect(v1?.rule.thresholds.vibrationZ).toBe(2);
    const view = await policies.view();
    expect(view.versions.map((x) => x.version)).toEqual([1, 2]);
    expect(view.versions[1]).toMatchObject({
      createdBy: "USR-ORG-ADMIN-001",
      reason: "Be stricter about vibration",
      basedOn: 1,
      builtin: false,
    });
    const entry = (await audit.list(ORG)).find((e) => e.action === "SIMULATION_POLICY_PUBLISHED");
    expect(entry).toMatchObject({
      actorId: "USR-ORG-ADMIN-001",
      targetId: "sim.2",
      beforeState: "sim.1",
      afterState: "sim.2",
      targetType: "POLICY",
    });
    expect(entry?.details?.changes).toEqual([
      "rule.vibrationZ: 2 -> 3",
      "rule.persistence: 3 -> 2",
    ]);
    expect(entry?.details?.reason).toBe("Be stricter about vibration");
  });

  it("refuses an invalid change, an unchanged change and a missing reason, writing nothing", async () => {
    const { policies } = make();
    expect(
      await policies.publish("U", withValues({ "rule.vibrationZ": 99 }), "reason"),
    ).toMatchObject({ ok: false, code: "INVALID" });
    expect(await policies.publish("U", defaults, "no change")).toMatchObject({
      ok: false,
      code: "INVALID",
    });
    expect(await policies.publish("U", withValues({ "rule.vibrationZ": 3 }), "")).toMatchObject({
      ok: false,
      code: "REASON_REQUIRED",
    });
    expect(
      await policies.publish("U", withValues({ "rule.vibrationZ": 3 }), "x".repeat(400)),
    ).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect((await policies.view()).versions).toHaveLength(1);
  });

  it("concurrent publishes get distinct versions", async () => {
    const { policies } = make();
    const results = await Promise.all([
      policies.publish("A", withValues({ "rule.vibrationZ": 2.5 }), "first change"),
      policies.publish("B", withValues({ "rule.vibrationZ": 3.5 }), "second change"),
    ]);
    const versions = results.map((r) => (r.ok ? r.version : 0)).sort();
    expect(versions).toEqual([2, 3]);
    expect((await policies.view()).versions.map((v) => v.version)).toEqual([1, 2, 3]);
  });

  it("rolls back by activating an earlier version, recording who did it", async () => {
    const { policies, audit, clock } = make();
    await policies.publish("A", withValues({ "rule.vibrationZ": 3 }), "stricter");
    expect(await policies.activate("B", 1, "go back")).toBe(true);
    clock.advance(3000);
    expect((await policies.active()).label).toBe("sim.1");
    expect(await policies.activate("B", 9, "nope")).toBe(false);
    const e = (await audit.list(ORG)).find((x) => x.action === "SIMULATION_POLICY_ACTIVATED");
    expect(e).toMatchObject({ actorId: "B", beforeState: "sim.2", afterState: "sim.1" });
    expect((await policies.view()).versions).toHaveLength(2); // history kept
  });

  it("a version stays reproducible from its stored values (a case can always be re-explained)", async () => {
    const { policies } = make();
    await policies.publish(
      "A",
      withValues({ "verification.postActionWindowSeconds": 90 }),
      "longer window",
    );
    const b2 = await policies.bundleFor(2);
    expect(b2?.verification.postActionWindow.durationSeconds).toBe(90);
    expect(b2?.verification.policyVersion).toBe("sim.2");
    expect((await policies.bundleFor(1))?.verification.postActionWindow.durationSeconds).toBe(60);
    expect(await policies.bundleFor(7)).toBeUndefined();
  });

  it("cannot weaken what the production parsers protect", () => {
    const raw = structuredClone(rawBase) as unknown as Record<string, Record<string, unknown>>;
    (
      (raw.verification as Record<string, unknown>).integrity as Record<string, unknown>
    ).requireAuthenticated = false;
    expect(() => buildPolicyBundle(raw as never, parameters, defaults, 1)).toThrow();
  });
});
