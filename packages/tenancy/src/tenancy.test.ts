import { describe, expect, it } from "vitest";
import {
  InMemoryActorDirectory,
  SYNTHETIC_ACTORS,
  canAccessFacility,
  createSyntheticActorDirectory,
} from "./index";

describe("synthetic local directory", () => {
  it("uses obviously synthetic IDs and no real addresses", () => {
    for (const a of SYNTHETIC_ACTORS) {
      expect(a.actorId).toMatch(/^USR-[A-Z0-9-]+$/);
      expect(JSON.stringify(a)).not.toMatch(/@|\.com/);
    }
  });

  it("derives organization and facility scope from the directory, per actor", async () => {
    const d = createSyntheticActorDirectory();
    const mgr = await d.get("USR-FACILITY-MGR-001");
    expect(mgr).toMatchObject({ organizationId: "ORG-SIM-001", facilityIds: ["FAC-SIM-001"] });
    expect(await d.get("USR-DOES-NOT-EXIST")).toBeUndefined();
  });

  it("finds a recipient by role within the organization and facility only", async () => {
    const d = createSyntheticActorDirectory();
    expect((await d.findByRole("ORG-SIM-001", "FAC-SIM-001", "FACILITY_MANAGER"))?.actorId).toBe(
      "USR-FACILITY-MGR-001",
    );
    expect((await d.findByRole("ORG-SIM-001", "FAC-SIM-001", "ORG_ADMIN"))?.actorId).toBe(
      "USR-ORG-ADMIN-001",
    );
    expect(await d.findByRole("ORG-SIM-002", "FAC-SIM-001", "FACILITY_MANAGER")).toBeUndefined();
    expect(await d.findByRole("ORG-SIM-001", "FAC-OTHER-001", "FACILITY_MANAGER")).toBeUndefined();
    expect(await new InMemoryActorDirectory([]).findByRole("O", "F", "OPERATOR")).toBeUndefined();
  });

  it("facility access honors explicit lists and ALL", () => {
    expect(
      canAccessFacility(
        { actorId: "a", organizationId: "o", facilityIds: ["F1"], roles: [] },
        "F1",
      ),
    ).toBe(true);
    expect(
      canAccessFacility(
        { actorId: "a", organizationId: "o", facilityIds: ["F1"], roles: [] },
        "F2",
      ),
    ).toBe(false);
    expect(
      canAccessFacility({ actorId: "a", organizationId: "o", facilityIds: "ALL", roles: [] }, "F9"),
    ).toBe(true);
  });
});
