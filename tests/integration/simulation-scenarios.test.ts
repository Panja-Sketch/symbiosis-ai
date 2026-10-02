import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  BACKUP,
  FAC,
  INSURER,
  MGR,
  ORG,
  closeAllWorlds,
  makeSimWorld,
} from "../support/sim-world";

afterEach(closeAllWorlds);

const SCOPES = [
  "RECOMMENDATION",
  "EVENT_SUMMARY",
  "ACTION_SUMMARY",
  "BEFORE_AFTER_METRICS",
  "VERIFICATION_RESULT",
  "VERIFICATION_CONFIDENCE",
  "RECURRENCE_STATUS",
  "EVIDENCE_ARTIFACTS",
];

describe("emerging deterioration: a watch, never a premature outcome", () => {
  it("the persistence develops but no case, alert or verification exists below the compound condition", async () => {
    const w = await makeSimWorld();
    await w.warmUp();
    await w.scenario("EMERGING_DETERIORATION");
    await w.steps(14, { tick: true });
    expect(await w.cases()).toHaveLength(0);
    expect(w.emails()).toHaveLength(0);
    const o = await w.overview();
    expect(["WATCH", "NORMAL", "INSUFFICIENT_DATA"]).toContain(o.rule.outcome);
    expect(o.activeCaseId ?? null).toBeNull();
  });
});

describe("sensor failure: missing or untrusted data never becomes verification", () => {
  it("a dropped-out vibration sensor after an action yields no VERIFIED result", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.scenario("SENSOR_QUALITY_FAILURE");
    await w.until(
      async () => (await w.verifications(caseId)).some((x) => x.status === "COMPLETED"),
      80,
      true,
    );
    const [att] = await w.verifications(caseId);
    expect(att?.assessment?.result).toBe("INCONCLUSIVE");
    expect((await w.caseView(caseId)).state).toBe("INCONCLUSIVE");
    // the case is not closed and not improved; a person is told through the configured follow-up
    expect(w.emails().some((m) => m.subject.startsWith("[FOLLOW-UP]"))).toBe(true);
  });
});

describe("weather failure: no fabricated weather, no fabricated context", () => {
  it("live weather without a configured provider is unavailable, and heat is not assumed", async () => {
    const w = await makeSimWorld();
    await w.warmUp();
    expect((await w.sim("POST", "/weather", ADMIN, { mode: "LIVE" })).status).toBe(200);
    // abnormal sensors, a hot day only in the simulated physical state, and a stable zone
    const patch = { vibrationRmsMs2: 0.62, currentA: 14, outdoorTemperatureC: 43 };
    expect((await w.sim("POST", "/state", ADMIN, { patch })).status).toBe(200);
    await w.steps(20, { tick: true });
    const o = await w.overview();
    expect(JSON.stringify(o.weather)).toMatch(/UNAVAILABLE|NOT_CONFIGURED/);
    expect(JSON.stringify(o.weather)).not.toMatch(/LIVE WEATHER|SIMULATED WEATHER/);
    expect(await w.cases()).toHaveLength(0);
    // switching to the explicit simulated mode is what makes the same world a compound condition
    expect((await w.sim("POST", "/weather", ADMIN, { mode: "SIMULATED" })).status).toBe(200);
    await w.until(async () => (await w.cases()).length > 0, 40, false);
    expect(await w.cases()).toHaveLength(1);
  });
});

describe("adapter equivalence: differently shaped vendor payloads, one canonical meaning", () => {
  it("a flat gateway and two specialised devices normalise to the same canonical observations", async () => {
    const w = await makeSimWorld();
    const r = await w.sim("GET", "/adapters/compare", ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.equivalent).toBe(true);
    expect(r.body.compared.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body.flat.payload)).not.toEqual(
      JSON.stringify(r.body.specialized[0].payload),
    );
  });
});

describe("consent, revocation and provenance of simulation evidence", () => {
  it("the insurer sees nothing without consent, only the granted scopes with a simulation label, and nothing after revocation", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId, BACKUP);
    await w.scenario("INEFFECTIVE_MITIGATION");
    await w.until(
      async () => (await w.verifications(caseId)).some((x) => x.status === "COMPLETED"),
      60,
      true,
    );
    const read = () => w.api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER);

    expect((await read()).status).toBe(403); // no agreement: nothing, and no hint that it exists
    const raw = await w.api(
      "GET",
      `/insurance/v1/cases/${caseId}/evidence?include=raw_telemetry`,
      INSURER,
    );
    expect(raw.status).toBe(403);

    const grant = await w.api("POST", "/api/v1/sharing-agreements", MGR, {
      recipientOrganizationId: "ORG-INS-001",
      facilityIds: [FAC],
      scopes: SCOPES,
    });
    expect(grant.status, JSON.stringify(grant.body)).toBe(201);
    const shared = await read();
    expect(shared.status).toBe(200);
    const text = JSON.stringify(shared.body);
    expect(text).toMatch(/SYNTHETIC|simulat/i);
    expect(shared.body.verification.result).toBe("NOT_IMPROVING"); // the real result, not softened
    expect(text).not.toContain('"observations"');
    expect(
      (await w.api("GET", `/insurance/v1/cases/${caseId}/evidence?include=raw_telemetry`, INSURER))
        .status,
    ).toBe(403); // raw telemetry was never granted

    const revoke = await w.api(
      "POST",
      `/api/v1/sharing-agreements/${grant.body.agreement.agreementId}/revoke`,
      MGR,
      { reason: "test" },
    );
    expect(revoke.status, JSON.stringify(revoke.body)).toBe(200);
    expect((await read()).status).toBe(403); // immediate
    void ORG;
  });
});
