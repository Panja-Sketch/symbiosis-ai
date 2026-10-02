import { afterEach, describe, expect, it } from "vitest";
import { FakeEmailTransport } from "@symbiosis/adapter-email";
import {
  ADMIN,
  BACKUP,
  FAC,
  INSPECT,
  INSURER,
  MGR,
  OPERATOR,
  ORG,
  OTHER,
  closeAllWorlds,
  makeSimWorld,
} from "../support/sim-world";

afterEach(closeAllWorlds);
void FakeEmailTransport;
void INSPECT;
void INSURER;
void OTHER;
void BACKUP;
void MGR;
void OPERATOR;

describe("A. normal operation: baseline learns, no case, no email", () => {
  it("learns READY baselines from vendor payloads and opens nothing", async () => {
    const w = await makeSimWorld();
    await w.warmUp();
    await w.steps(12, { tick: true });
    const o = await w.overview();
    expect(o.baseline.ready).toBe(true);
    expect(o.baseline.signals.map((s: { status: string }) => s.status)).toEqual(["READY", "READY", "READY"]);
    expect(await w.cases()).toHaveLength(0);
    expect(w.emails()).toHaveLength(0);
    // every sensor shows data from a labelled synthetic vendor, with the unit and trust the pipeline assigned
    const vib = o.sensors.find((s: { signal: string }) => s.signal === "vibration_rms");
    expect(vib).toMatchObject({ status: "NORMAL", trusted: true, synthetic: true, sourceType: "SIMULATOR", sourceLabel: "Vibration Sensor Gateway" });
    expect(vib.sourceAdapter).toBe("sim-vibration-gateway@v1");
    expect(vib.value).toBeGreaterThan(0.25);
    expect(vib.value).toBeLessThan(0.35);
    const cur = o.sensors.find((s: { signal: string }) => s.signal === "current");
    expect(cur.value).toBeGreaterThan(11.5);
    expect(cur.value).toBeLessThan(12.5);
    expect(cur.sourceAdapter).toBe("sim-electrical-meter@v1");
    const zone = o.sensors.find((s: { signal: string; assetId: string }) => s.signal === "temperature");
    expect(zone.value).toBeCloseTo(4.2, 1);
    expect(zone.sourceAdapter).toBe("sim-hvac-controller@v1");
    // all three vendors reach the same canonical contract
    const stored = await w.runtime.observations.list(ORG);
    const canonical = stored.filter((x) => x.facilityId === FAC);
    expect(new Set(canonical.map((x) => x.sourceAdapter))).toEqual(
      new Set(["sim-vibration-gateway@v1", "sim-electrical-meter@v1", "sim-hvac-controller@v1"]),
    );
    for (const x of canonical) {
      expect(x.sourceType).toBe("SIMULATOR");
      expect(x.quality.authVerified).toBe(true);
    }
  });

  it("refuses an abnormal world while the baseline is still learning", async () => {
    const w = await makeSimWorld();
    await w.start();
    await w.steps(3);
    const r = await w.sim("POST", "/scenario", ADMIN, { scenarioId: "COMPOUND_COOLING_RISK" });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BASELINE_LEARNING");
    expect((await w.sim("POST", "/state", ADMIN, { patch: { vibrationRmsMs2: 0.9 } })).status).toBe(409);
    expect((await w.sim("POST", "/scenario", ADMIN, { scenarioId: "NORMAL" })).status).toBe(200);
  });
});

describe("B. compound risk: sensors + context -> one case + one alert", () => {
  it("persistence builds, one case opens, one email is sent to the facility manager", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    const cases = await w.cases();
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({ state: "OPEN", hazardType: "COOLING_ELECTRICAL_DETERIORATION" });
    expect(["HIGH", "CRITICAL"]).toContain(cases[0]?.severity);
    // the rule's own conclusion, copied from storage, is what the screen shows
    const o = await w.overview();
    expect(o.rule.outcome).toBe("CANDIDATE_RISK");
    expect(o.rule.persistence).toMatchObject({ qualifyingEvaluations: expect.any(Number), required: 3 });
    expect(o.rule.ruleVersion).toBe("sim.1");
    const met = Object.fromEntries(o.rule.conditions.map((c: { id: string; met: boolean }) => [c.id, c.met]));
    expect(met).toMatchObject({ VIBRATION: true, CURRENT: true });
    // context: heat OR a rising zone temperature (the 20-second ramp may not have finished yet)
    expect(met.HEAT === true || met.ZONE_RISING === true).toBe(true);
    // a single alert email, from the sender channel, to the role holder, with the trusted facts only
    expect(w.emails()).toHaveLength(1);
    const mail = w.emails()[0];
    expect(mail?.to).toBe("usr-facility-mgr-001@symbiosis-demo.example");
    expect(mail?.subject).toMatch(/^\[ALERT\] \[(HIGH|CRITICAL)\] .*Northgate Cold Storage - Phoenix/);
    expect(mail?.text).toMatch(/Facility: Northgate Cold Storage - Phoenix/);
    expect(mail?.text).toContain(`https://app.example/operations/cases/${caseId}`);
    expect(mail?.text).toMatch(/Primary Cooling Unit \(CU-A\)/);
    expect(mail?.text).toMatch(/Recommended approved actions/);
    expect(mail?.text).not.toMatch(/hmac|signature|secret|password/i);
    // case + delivery record + audited timeline from real records
    const v = await w.caseView(caseId);
    expect(v.state).toBe("OPEN");
    const ov = await w.overview();
    expect(ov.activeCaseId).toBe(caseId);
    expect(ov.notifications).toHaveLength(1);
    expect(ov.notifications[0]).toMatchObject({ kind: "INITIAL", status: "SENT", channel: "EMAIL", addressHint: "u***1@symbiosis-demo.example" });
    const tl = (await w.sim("GET", "/timeline")).body.items as { title: string; kind: string }[];
    const titles = tl.map((i) => i.title);
    expect(titles.some((t) => t.startsWith("Scenario applied: COMPOUND_COOLING_RISK"))).toBe(true);
    expect(titles.some((t) => /Compound condition present: persistence/.test(t))).toBe(true);
    expect(titles.some((t) => /Risk detected: case opened/.test(t))).toBe(true);
    expect(titles.some((t) => /Alert email sent/.test(t))).toBe(true);
  });

  it("more abnormal pulses keep one case and send no second alert", async () => {
    const w = await makeSimWorld();
    await w.detect();
    await w.steps(12, { tick: true });
    expect(await w.cases()).toHaveLength(1);
    expect(w.emails()).toHaveLength(1);
  });

  it("weather and sensors combine only through the rule: mild simulated weather and a stable zone give no case", async () => {
    const w = await makeSimWorld();
    await w.warmUp();
    // abnormal vibration and current, but no heat context and a perfectly stable zone temperature
    const patch = { vibrationRmsMs2: 0.62, currentA: 14, outdoorTemperatureC: 20 };
    expect((await w.sim("POST", "/weather", ADMIN, { mode: "SIMULATED" })).status).toBe(200);
    expect((await w.sim("POST", "/state", ADMIN, { patch })).status).toBe(200);
    await w.steps(20, { tick: true });
    expect(await w.cases()).toHaveLength(0);
    const o = await w.overview();
    expect(o.rule.outcome).toBe("WATCH");
    const met = Object.fromEntries(o.rule.conditions.map((c: { id: string; met: boolean }) => [c.id, c.met]));
    expect(met).toMatchObject({ VIBRATION: true, CURRENT: true, HEAT: false, ZONE_RISING: false });
    // now it gets hot: the SAME sensors plus the context become a compound condition
    expect((await w.sim("POST", "/state", ADMIN, { patch: { outdoorTemperatureC: 43 } })).status).toBe(200);
    await w.until(async () => (await w.cases()).length > 0, 40, false);
    expect(await w.cases()).toHaveLength(1);
  });
});

describe("C. ineffective action: reported complete is NOT improved", () => {
  it("action reported + values unchanged -> verification NOT_IMPROVING (never VERIFIED) -> one follow-up email", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    // the person says it is done; the simulated world does not improve (backup runs, primary stays degraded)
    await w.scenario("INEFFECTIVE_MITIGATION");
    const v0 = await w.caseView(caseId);
    expect(v0.state).toBe("ACTION_REPORTED");
    expect(JSON.stringify(v0.didItWork).toUpperCase()).toContain("PENDING");
    await w.until(async () => (await w.verifications(caseId)).some((x) => x.status === "COMPLETED"), 60, true);
    const [att] = await w.verifications(caseId);
    expect(att?.assessment?.result).toBe("NOT_IMPROVING");
    expect(att?.policyVersion).toBe("sim.1");
    const v1 = await w.caseView(caseId);
    expect(v1.state).toBe("NOT_IMPROVING");
    // the deterministic follow-up: exactly one email, referencing the prior action and the failed criterion
    const follow = w.emails().filter((m) => m.subject.startsWith("[FOLLOW-UP]"));
    expect(follow).toHaveLength(1);
    expect(follow[0]?.text).toMatch(/did not improve/);
    expect(follow[0]?.text).toMatch(/Start approved backup cooling capacity/);
    expect(follow[0]?.text).toMatch(/Vibration: FAIL/);
    expect(follow[0]?.text).toMatch(/reported action is evidence that something was done/);
    // more ticks never duplicate it
    await w.steps(10, { tick: true });
    expect(w.emails().filter((m) => m.subject.startsWith("[FOLLOW-UP]"))).toHaveLength(1);
    const alerts = await w.runtime.alerts.listByCase(ORG, caseId);
    expect(alerts.filter((a) => a.kind === "FOLLOW_UP")).toHaveLength(1);
    expect(alerts.find((a) => a.kind === "FOLLOW_UP")?.trigger?.type).toBe("VERIFICATION_NOT_IMPROVING");
    // an evidence package preserves the real result and is labelled as simulation data
    const view = await w.caseView(caseId);
    expect(view.evidencePackages?.length ?? 0).toBeGreaterThan(0);
    const audit = (await w.runtime.audit.listByCase(ORG, caseId)).map((e) => e.action);
    expect(audit).toContain("FOLLOW_UP_REQUESTED");
    expect(audit).toContain("VERIFICATION_COMPLETED");
  });
});

describe("D. successful action after a failed one: a legitimate second cycle -> VERIFIED_IMPROVED", () => {
  it("NOT_IMPROVING -> new approved action -> genuinely improved world -> VERIFIED (no follow-up, evidence is simulation data)", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.scenario("INEFFECTIVE_MITIGATION");
    await w.until(async () => (await w.verifications(caseId)).some((x) => x.status === "COMPLETED"), 60, true);
    expect((await w.caseView(caseId)).state).toBe("NOT_IMPROVING");
    const followUpsBefore = w.emails().filter((m) => m.subject.startsWith("[FOLLOW-UP]")).length;

    // a person acts again (a different approved action); the world genuinely improves
    await w.reportAction(caseId, INSPECT, false);
    await w.scenario("SUCCESSFUL_MITIGATION");
    await w.until(async () => (await w.verifications(caseId)).filter((x) => x.status === "COMPLETED").length >= 2, 80, true);
    const attempts = await w.verifications(caseId);
    expect(attempts.map((a) => a.assessment?.result)).toEqual(["NOT_IMPROVING", "VERIFIED"]);
    const v = await w.caseView(caseId);
    expect(v.state).toBe("VERIFIED_IMPROVED");
    // a verified improvement needs no follow-up
    expect(w.emails().filter((m) => m.subject.startsWith("[FOLLOW-UP]"))).toHaveLength(followUpsBefore);
    // evidence: the verified package is created and labelled as simulation data, never as real telemetry
    const pkgs = await w.runtime.evidencePackages.listByCase(ORG, caseId);
    expect(pkgs.length).toBeGreaterThanOrEqual(2);
    const loaded = await w.runtime.evidenceService.load(ORG, pkgs[pkgs.length - 1]?.packageId ?? "");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.package.payload.source).toMatchObject({ synthetic: true, dataOrigin: "SYNTHETIC_SIMULATOR" });
      expect(loaded.value.package.payload.source.label).toMatch(/SYNTHETIC|SIMULATION/i);
      expect(loaded.value.package.payload.verification.policyVersion).toBe("sim.1");
    }
  });
});

describe("E. recurrence: the same case reopens with a new risk event and a recurrence email", () => {
  it("VERIFIED_IMPROVED -> the fault returns -> same case REOPENED, count +1, no duplicate case", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.scenario("SUCCESSFUL_MITIGATION");
    await w.until(async () => (await w.caseView(caseId)).state === "VERIFIED_IMPROVED", 100, true);
    const before = w.emails().length;
    await w.scenario("RECURRENCE");
    await w.until(async () => (await w.caseView(caseId)).state === "REOPENED", 60, true);
    const cases = await w.cases();
    expect(cases).toHaveLength(1);
    expect(cases[0]?.caseId).toBe(caseId);
    expect(cases[0]?.recurrenceCount).toBe(1);
    const events = await w.runtime.riskEvents.listByCase(ORG, caseId);
    expect(events.length).toBe(2);
    const mail = w.emails().slice(before).filter((m) => m.subject.startsWith("[RECURRENCE]"));
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toMatch(/verified as improved has returned/);
    // preserved: the earlier evidence package is still there
    expect((await w.runtime.evidencePackages.listByCase(ORG, caseId)).length).toBeGreaterThanOrEqual(1);
  });
});
