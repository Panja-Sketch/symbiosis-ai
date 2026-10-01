import { describe, expect, it } from "vitest";
import {
  SYNTHETIC_ACTORS,
  SYNTHETIC_ORGANIZATIONS,
  canAccessFacility,
  createSyntheticActorDirectory,
  createSyntheticOrganizationDirectory,
} from "./index";

describe("synthetic organizations (S6)", () => {
  it("every actor belongs to a known organization, and facility membership is server-side data", async () => {
    const orgs = createSyntheticOrganizationDirectory();
    for (const a of SYNTHETIC_ACTORS) {
      const org = await orgs.get(a.organizationId);
      expect(org, a.actorId).toBeDefined();
      if (a.facilityIds !== "ALL") {
        for (const f of a.facilityIds) expect(org?.facilityIds, a.actorId).toContain(f);
      }
    }
  });

  it("insured organizations own facilities; insurer organizations own none", async () => {
    const orgs = createSyntheticOrganizationDirectory();
    expect(await orgs.get("ORG-SIM-001")).toMatchObject({
      type: "INSURED",
      facilityIds: ["FAC-SIM-001"],
    });
    expect((await orgs.get("ORG-SIM-002"))?.facilityIds).toEqual(["FAC-OTHER-001"]);
    for (const id of ["ORG-INS-001", "ORG-INS-002"]) {
      expect(await orgs.get(id)).toMatchObject({ type: "INSURER", facilityIds: [] });
    }
    expect(await orgs.get("ORG-NOBODY")).toBeUndefined();
  });

  it("no facility belongs to two organizations", () => {
    const all = SYNTHETIC_ORGANIZATIONS.flatMap((o) => o.facilityIds);
    expect(new Set(all).size).toBe(all.length);
  });

  it("insurer actors are in insurer organizations, have insurer roles only, and use no real addresses", async () => {
    const dir = createSyntheticActorDirectory();
    for (const id of ["USR-RISK-ENGINEER-001", "USR-UNDERWRITER-001", "USR-OTHER-INSURER-RE-001"]) {
      const a = await dir.get(id);
      expect(a?.organizationId).toMatch(/^ORG-INS-/);
      expect(a?.roles.every((r) => r === "RISK_ENGINEER" || r === "UNDERWRITER")).toBe(true);
      expect(JSON.stringify(a)).not.toMatch(/@|\.com/);
    }
    // an insurer actor's blanket facility scope never grants access to an insured's own workflow
    const re = await dir.get("USR-RISK-ENGINEER-001");
    expect(canAccessFacility(re as NonNullable<typeof re>, "FAC-SIM-001")).toBe(true); // "ALL" of its own (empty) org
    expect(await dir.findByRole("ORG-SIM-001", "FAC-SIM-001", "RISK_ENGINEER")).toBeUndefined();
  });
});
