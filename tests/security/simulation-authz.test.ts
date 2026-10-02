import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  AUDITOR,
  INSURER,
  MGR,
  OPERATOR,
  OTHER,
  closeAllWorlds,
  makeSimWorld,
} from "../support/sim-world";

/**
 * Authorization and tenant isolation of `/api/v1/simulation/*` (S10, D-091/D-092). The scope (one
 * tenant, one facility) is fixed on the server; the caller's identity comes from the directory, so
 * nothing in a body, query or path can widen it.
 */
afterEach(closeAllWorlds);

const WRITES: readonly [string, string, unknown][] = [
  ["POST", "/session/start", {}],
  ["POST", "/session/stop", {}],
  ["POST", "/scenario", { scenarioId: "NORMAL" }],
  ["POST", "/state", { patch: {} }],
  ["POST", "/weather", { mode: "SIMULATED" }],
  ["POST", "/pulse", {}],
  ["POST", "/tick", {}],
  ["POST", "/reset", { confirm: "RESET" }],
  ["POST", "/policy", { values: {}, reason: "x" }],
  ["POST", "/policy/activate", { version: 1, reason: "x" }],
  ["POST", "/adapters/publish", {}],
  ["POST", "/adapters/activate", {}],
];
const READS = ["", "/timeline", "/series", "/policy", "/adapters", "/adapters/compare"];

describe("simulation API: who may do what", () => {
  it("denies every identity outside the simulation tenant the same 404 as an unknown route (reads and writes)", async () => {
    const w = await makeSimWorld();
    const unknown = (await w.sim("GET", "/does-not-exist", OTHER)).body;
    for (const actor of [OTHER, INSURER]) {
      for (const r of READS) {
        const res = await w.sim("GET", r, actor);
        expect(res.status, `${actor} GET ${r}`).toBe(404);
        expect(res.body).toEqual(unknown);
      }
      for (const [m, r, b] of WRITES) {
        const res = await w.sim(m, r, actor, b);
        expect(res.status, `${actor} ${m} ${r}`).toBe(404);
      }
    }
  });

  it("an unauthenticated or unknown caller gets 401 and nothing happens", async () => {
    const w = await makeSimWorld();
    for (const actor of ["", "USR-DOES-NOT-EXIST"]) {
      const res = await fetch(`${w.runtime.server.baseUrl}/api/v1/simulation`, {
        headers: actor === "" ? {} : { "X-Demo-Actor-Id": actor },
      });
      expect(res.status).toBe(401);
    }
    expect((await w.overview()).session.status).not.toBe("RUNNING");
  });

  it("an auditor may read but cannot control, edit or reset", async () => {
    const w = await makeSimWorld();
    for (const r of READS) expect((await w.sim("GET", r, AUDITOR)).status, r).toBe(200);
    for (const [m, r, b] of WRITES) {
      const res = await w.sim(m, r, AUDITOR, b);
      if (r === "/tick" && res.status === 404) continue; // not wired in this runtime
      expect(res.status, `${m} ${r}`).toBe(403);
    }
  });

  it("an operator can drive the session but not reset, or edit policy or adapters", async () => {
    const w = await makeSimWorld();
    expect((await w.sim("POST", "/session/start", OPERATOR)).status).toBe(200);
    for (const [r, b] of [
      ["/reset", { confirm: "RESET" }],
      ["/policy", { values: {}, reason: "x" }],
      ["/policy/activate", { version: 1, reason: "x" }],
      ["/adapters/publish", {}],
      ["/adapters/activate", {}],
    ] as const) {
      expect((await w.sim("POST", r, OPERATOR, b)).status, r).toBe(403);
    }
  });

  it("the caller cannot name another tenant or facility: scope in the body is ignored", async () => {
    const w = await makeSimWorld();
    await w.start();
    const res = await w.sim("POST", "/scenario", MGR, {
      scenarioId: "NORMAL",
      organizationId: "ORG-SIM-002",
      facilityId: "FAC-OTHER",
      sessionId: "SES-OTHER",
    });
    expect(res.status).toBe(200);
    const o = await w.overview(MGR);
    expect(JSON.stringify(o)).toContain("FAC-SIM-PHX-01");
    expect(JSON.stringify(o)).not.toContain("FAC-OTHER");
    expect(JSON.stringify(res.body)).not.toContain("ORG-SIM-002");
    for (const q of [
      "?organizationId=ORG-SIM-002",
      "?facilityId=FAC-OTHER",
      "?sessionId=SES-OTHER",
    ]) {
      const r = await w.sim("GET", `/timeline${q}`, MGR);
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toContain("ORG-SIM-002");
    }
  });

  it("a cross-tenant reset is refused and the owner's session and data are untouched", async () => {
    const w = await makeSimWorld();
    await w.warmUp();
    const before = await w.overview();
    const res = await w.sim("POST", "/reset", OTHER, { confirm: "RESET" });
    expect(res.status).toBe(404);
    const after = await w.overview();
    expect(after.session.generation).toBe(before.session.generation);
    expect(after.session.status).toBe(before.session.status);
    expect(after.baseline.ready).toBe(true);
  });

  it("a reset needs the typed confirmation, even for an administrator", async () => {
    const w = await makeSimWorld();
    await w.start();
    for (const body of [{}, { confirm: "yes" }, { confirm: true }]) {
      const res = await w.sim("POST", "/reset", ADMIN, body);
      expect(res.status).toBe(400);
    }
  });

  it("cross-tenant policy and adapter editing are refused and change nothing", async () => {
    const w = await makeSimWorld();
    const policy = (await w.sim("GET", "/policy", ADMIN)).body;
    const adapters = (await w.sim("GET", "/adapters", ADMIN)).body;
    for (const [r, b] of [
      ["/policy", { values: {}, reason: "attack" }],
      ["/policy/activate", { version: 1, reason: "attack" }],
      ["/adapters/publish", { definition: {} }],
      ["/adapters/activate", { profileId: "sim-bas-gateway", version: 1 }],
    ] as const) {
      expect((await w.sim("POST", r, OTHER, b)).status, r).toBe(404);
    }
    expect((await w.sim("GET", "/policy", ADMIN)).body).toEqual(policy);
    expect((await w.sim("GET", "/adapters", ADMIN)).body).toEqual(adapters);
  });

  it("an insurer cannot reach the case commands that the simulation workspace proxies", async () => {
    const w = await makeSimWorld();
    const caseId = await w.detect();
    for (const [m, p, b] of [
      ["GET", `/api/v1/cases/${caseId}`, undefined],
      ["POST", `/api/v1/cases/${caseId}/acknowledge`, {}],
      ["POST", `/api/v1/cases/${caseId}/assignments`, {}],
      ["POST", `/api/v1/cases/${caseId}/actions`, {}],
    ] as const) {
      const res = await w.api(m, p, INSURER, b);
      expect([401, 403, 404], `${m} ${p}`).toContain(res.status);
    }
    expect([401, 403, 404]).toContain(
      (await w.api("GET", `/api/v1/cases/${caseId}`, OTHER)).status,
    );
    expect((await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, OTHER, {})).status).toBe(
      404,
    );
  });
});
