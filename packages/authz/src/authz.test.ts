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
    expect(permissionsFor(["READ_ONLY_AUDITOR"])).toEqual([
      "CASE_READ",
      "INTERVENTION_READ",
      "EVIDENCE_READ",
      "SIMULATION_READ",
    ]);
    // S6: insurer-side roles can only read the consent-filtered evidence API, nothing else.
    for (const r of ["RISK_ENGINEER", "UNDERWRITER", "BROKER_RISK_MANAGER"] as const) {
      expect(permissionsFor([r])).toEqual(["INSURANCE_EVIDENCE_READ"]);
    }
  });

  it("sharing: managers grant and revoke, only an admin may grant raw telemetry, insurers cannot share", () => {
    expect(can(actor(["FACILITY_MANAGER"]), "SHARING_MANAGE")).toBe(true);
    expect(can(actor(["FACILITY_MANAGER"]), "SHARING_GRANT_RAW_TELEMETRY")).toBe(false);
    expect(can(actor(["ORG_ADMIN"]), "SHARING_GRANT_RAW_TELEMETRY")).toBe(true);
    expect(can(actor(["ORG_ADMIN"]), "INSURANCE_EVIDENCE_READ")).toBe(false);
    expect(can(actor(["OPERATOR"]), "EVIDENCE_READ")).toBe(false);
    expect(can(actor(["READ_ONLY_AUDITOR"]), "SHARING_MANAGE")).toBe(false);
    for (const r of ["RISK_ENGINEER", "UNDERWRITER", "BROKER_RISK_MANAGER"] as const) {
      expect(can(actor([r]), "SHARING_MANAGE")).toBe(false);
      expect(can(actor([r]), "CASE_READ")).toBe(false);
    }
  });

  it("intervention recommendations: managers and admins act, auditors read, operators have no access (S5)", () => {
    expect(can(actor(["FACILITY_MANAGER"]), "INTERVENTION_ACKNOWLEDGE")).toBe(true);
    expect(can(actor(["ORG_ADMIN"]), "INTERVENTION_READ")).toBe(true);
    expect(can(actor(["READ_ONLY_AUDITOR"]), "INTERVENTION_READ")).toBe(true);
    expect(can(actor(["READ_ONLY_AUDITOR"]), "INTERVENTION_ACKNOWLEDGE")).toBe(false);
    expect(can(actor(["OPERATOR"]), "INTERVENTION_READ")).toBe(false);
  });

  it("an actor with no roles can do nothing", () => {
    expect(can(actor([]), "CASE_READ")).toBe(false);
  });

  it("the facility simulation is operations only: never an insurer, never an auditor's control", () => {
    for (const r of ["RISK_ENGINEER", "UNDERWRITER", "BROKER_RISK_MANAGER"] as const) {
      for (const p of [
        "SIMULATION_READ",
        "SIMULATION_CONTROL",
        "SIMULATION_POLICY_EDIT",
        "SIMULATION_ADAPTER_EDIT",
        "CONTACT_MANAGE",
      ] as const) {
        expect(can(actor([r]), p), `${r} ${p}`).toBe(false);
      }
    }
    expect(can(actor(["READ_ONLY_AUDITOR"]), "SIMULATION_READ")).toBe(true);
    expect(can(actor(["READ_ONLY_AUDITOR"]), "SIMULATION_CONTROL")).toBe(false);
    expect(can(actor(["OPERATOR"]), "SIMULATION_CONTROL")).toBe(true);
    expect(can(actor(["OPERATOR"]), "SIMULATION_POLICY_EDIT")).toBe(false);
    expect(can(actor(["FACILITY_MANAGER"]), "SIMULATION_POLICY_EDIT")).toBe(true);
    expect(can(actor(["FACILITY_MANAGER"]), "CONTACT_MANAGE")).toBe(false);
    expect(can(actor(["ORG_ADMIN"]), "CONTACT_MANAGE")).toBe(true);
  });
});
