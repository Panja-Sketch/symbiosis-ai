import { afterEach, describe, expect, it } from "vitest";
import { MGR, OPERATOR, closeAll, makeWorld } from "./s6-world";

afterEach(async () => {
  await closeAll();
});

describe("S7 minimal backend read projections", () => {
  it("the development identity list is local-only, needs no actor and exposes no secret", async () => {
    const w = await makeWorld();
    const res = await fetch(`${w.runtime.server.baseUrl}/api/v1/dev/identities`);
    const body = (await res.json()) as {
      identity: string;
      actors: { actorId: string; permissions: string[] }[];
      organizations: { organizationId: string }[];
    };
    expect(res.status).toBe(200);
    expect(body.identity).toBe("DEVELOPMENT_ONLY");
    expect(body.actors.map((a) => a.actorId)).toContain(MGR);
    expect(body.organizations.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(body)).not.toMatch(/secret|password|token|key/i);
  });

  it("an unknown actor still gets 401 on every other route", async () => {
    const w = await makeWorld();
    expect((await w.api("GET", "/api/v1/cases", "USR-NOBODY")).status).toBe(401);
  });

  it("nextSteps follows the persisted workflow state and never replaces the API's checks", async () => {
    const w = await makeWorld();
    const id = await w.detect();
    let v = (await w.api("GET", `/api/v1/cases/${id}`, MGR)).body;
    expect(v.nextSteps).toEqual({ canAcknowledge: true, canAssignOrReport: false });
    // the API refuses what the projection says is not yet possible
    const early = await w.api("POST", `/api/v1/cases/${id}/assignments`, MGR, {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    expect(early.status).toBe(409);
    await w.api("POST", `/api/v1/cases/${id}/acknowledge`, MGR, {});
    v = (await w.api("GET", `/api/v1/cases/${id}`, MGR)).body;
    expect(v.nextSteps).toEqual({ canAcknowledge: false, canAssignOrReport: true });
    await w.reportAction(id, undefined, true);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    v = (await w.api("GET", `/api/v1/cases/${id}`, MGR)).body;
    expect(v.nextSteps).toEqual({ canAcknowledge: false, canAssignOrReport: false });
  });
});
