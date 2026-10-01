import { describe, expect, it } from "vitest";
import type { RiskImprovementCase } from "@symbiosis/contracts";
import { applyCaseCommand, applyCaseDocumentation, checkCaseInvariants } from "./index";

const verified: RiskImprovementCase = {
  caseId: "CASE-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  assetIds: ["AST-1"],
  origin: { type: "DETECTED_HAZARD", detectionId: "DET-1" },
  hazardType: "H",
  title: "T",
  severity: "HIGH",
  state: "VERIFIED_IMPROVED",
  latestVerificationId: "VER-1",
  activeRiskEventId: "EVT-1",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T01:00:00.000Z",
};

describe("case documentation commands (S6)", () => {
  it("recording a package changes only latestEvidencePackageId", () => {
    const r = applyCaseDocumentation(verified, {
      type: "RECORD_EVIDENCE_PACKAGE",
      evidencePackageId: "EVP-1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ ...verified, latestEvidencePackageId: "EVP-1" });
      expect(r.value.updatedAt).toBe(verified.updatedAt);
      expect(r.value.state).toBe("VERIFIED_IMPROVED");
      expect(r.value.sharingState).toBe("NOT_SHARED");
    }
    expect(verified.latestEvidencePackageId).toBeUndefined(); // input untouched
  });

  it("works in every state without being a lifecycle transition", () => {
    for (const state of [
      "OPEN",
      "ACTION_REPORTED",
      "INCONCLUSIVE",
      "NOT_IMPROVING",
      "CLOSED",
      "REOPENED",
    ] as const) {
      const c: RiskImprovementCase = {
        ...verified,
        state,
        ...(state === "REOPENED" && { recurrenceCount: 1 }),
        ...(state !== "INCONCLUSIVE" &&
          state !== "NOT_IMPROVING" && { latestVerificationId: undefined }),
      } as RiskImprovementCase;
      const r = applyCaseDocumentation(c, {
        type: "RECORD_EVIDENCE_PACKAGE",
        evidencePackageId: "EVP-1",
      });
      expect(r.ok, state).toBe(true);
      expect(r.ok && r.value.state).toBe(state);
    }
  });

  it("sharing state SHAREABLE, SHARED and REVOKED require a package; NOT_SHARED does not", () => {
    for (const s of ["SHAREABLE", "SHARED", "REVOKED"] as const) {
      expect(
        applyCaseDocumentation(verified, { type: "SET_SHARING_STATE", sharingState: s }).ok,
        s,
      ).toBe(false);
    }
    expect(
      applyCaseDocumentation(verified, { type: "SET_SHARING_STATE", sharingState: "NOT_SHARED" })
        .ok,
    ).toBe(true);
    const withPkg = { ...verified, latestEvidencePackageId: "EVP-1" };
    for (const s of ["SHAREABLE", "SHARED", "REVOKED"] as const) {
      const r = applyCaseDocumentation(withPkg, { type: "SET_SHARING_STATE", sharingState: s });
      expect(r.ok && r.value.sharingState).toBe(s);
      expect(r.ok && r.value.state).toBe("VERIFIED_IMPROVED");
    }
  });

  it("rejects an empty id and an unknown sharing state", () => {
    expect(
      applyCaseDocumentation(verified, { type: "RECORD_EVIDENCE_PACKAGE", evidencePackageId: " " })
        .ok,
    ).toBe(false);
    expect(
      applyCaseDocumentation(verified, {
        type: "SET_SHARING_STATE",
        sharingState: "PUBLIC" as never,
      }).ok,
    ).toBe(false);
  });

  it("the case invariants flag a shared case without a package", () => {
    expect(checkCaseInvariants({ ...verified, sharingState: "SHARED" })).toContain(
      "SHARED requires latestEvidencePackageId",
    );
    expect(
      checkCaseInvariants({
        ...verified,
        sharingState: "SHARED",
        latestEvidencePackageId: "EVP-1",
      }),
    ).toEqual([]);
  });

  it("lifecycle commands still keep the documentation fields and leave them alone", () => {
    const c: RiskImprovementCase = {
      ...verified,
      latestEvidencePackageId: "EVP-1",
      sharingState: "SHARED",
    };
    const r = applyCaseCommand(c, {
      type: "RECORD_RECURRENCE",
      at: "2026-10-01T02:00:00.000Z",
      newRiskEventId: "EVT-2",
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.value.value).toMatchObject({
        state: "REOPENED",
        latestEvidencePackageId: "EVP-1",
        sharingState: "SHARED",
      });
  });
});
