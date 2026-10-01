import { describe, expect, it } from "vitest";
import { can, permissionsFor } from "./index";

describe("local role permissions (not production authorization)", () => {
  const actor = (roles: Parameters<typeof permissionsFor>[0]) => ({
    actorId: "a",
    organizationId: "o",
    facilityIds: "ALL" as const,
    roles,
  });

  it("facility manager can run the workflow; operator can acknowledge and report but not assign or dismiss", () => {
    expect(can(actor(["FACILITY_MANAGER"]), "ACTION_ASSIGN")).toBe(true);
    expect(can(actor(["FACILITY_MANAGER"]), "RISK_DISMISS")).toBe(true);
    expect(can(actor(["OPERATOR"]), "ACTION_REPORT")).toBe(true);
    expect(can(actor(["OPERATOR"]), "ACTION_ASSIGN")).toBe(false);
    expect(can(actor(["OPERATOR"]), "RISK_DISMISS")).toBe(false);
  });

  it("only an org admin can run the maintenance tick", () => {
    expect(can(actor(["ORG_ADMIN"]), "OPS_TICK")).toBe(true);
    expect(can(actor(["FACILITY_MANAGER"]), "OPS_TICK")).toBe(false);
  });

  it("auditors read only; insurer-side roles have no operations permissions", () => {
    expect(permissionsFor(["READ_ONLY_AUDITOR"])).toEqual(["CASE_READ"]);
    for (const r of ["RISK_ENGINEER", "UNDERWRITER", "BROKER_RISK_MANAGER"] as const) {
      expect(permissionsFor([r])).toEqual([]);
    }
  });

  it("an actor with no roles can do nothing", () => {
    expect(can(actor([]), "CASE_READ")).toBe(false);
  });
});
