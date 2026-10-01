import { describe, expect, it } from "vitest";
import { CONSENT_SCOPES, EVIDENCE_CONSENT_SCOPES } from "@symbiosis/contracts";
import type { ConsentScope, SharingAgreement } from "@symbiosis/contracts";
import {
  EVIDENCE_PACKAGE_SCOPES,
  agreementStatus,
  deriveSharingState,
  evaluateAccess,
  isConsentScope,
} from "./access";

const T0 = Date.parse("2026-10-01T00:00:00Z");

const agreement = (patch: Partial<SharingAgreement> = {}): SharingAgreement => ({
  agreementId: "AGR-1",
  organizationId: "ORG-A",
  recipientOrganizationId: "ORG-I",
  scopes: ["VERIFICATION_RESULT", "RECOMMENDATION"],
  facilityIds: ["FAC-1"],
  effectiveFrom: new Date(T0 - 1000).toISOString(),
  createdBy: "USR-1",
  createdAt: new Date(T0 - 2000).toISOString(),
  ...patch,
});

const request = (patch: Partial<Parameters<typeof evaluateAccess>[1]> = {}) => ({
  recipientOrganizationId: "ORG-I",
  ownerOrganizationId: "ORG-A",
  facilityId: "FAC-1",
  anyOfScopes: ["VERIFICATION_RESULT"] as ConsentScope[],
  nowMs: T0,
  ...patch,
});

describe("scope vocabulary", () => {
  it("contains the spec categories, the S6 intervention scope and a separate raw scope", () => {
    expect([...CONSENT_SCOPES]).toEqual([
      "RECOMMENDATION",
      "EVENT_SUMMARY",
      "ACTION_SUMMARY",
      "BEFORE_AFTER_METRICS",
      "VERIFICATION_RESULT",
      "VERIFICATION_CONFIDENCE",
      "RECURRENCE_STATUS",
      "EVIDENCE_ARTIFACTS",
      "INTERVENTION_RECOMMENDATION",
      "RAW_TELEMETRY",
    ]);
  });

  it("the broad evidence grant never includes raw telemetry", () => {
    expect(EVIDENCE_CONSENT_SCOPES).not.toContain("RAW_TELEMETRY");
    expect(EVIDENCE_CONSENT_SCOPES).toHaveLength(CONSENT_SCOPES.length - 1);
  });

  it("package-releasing scopes exclude recommendation and intervention scopes", () => {
    expect(EVIDENCE_PACKAGE_SCOPES).not.toContain("RECOMMENDATION");
    expect(EVIDENCE_PACKAGE_SCOPES).not.toContain("INTERVENTION_RECOMMENDATION");
    expect(EVIDENCE_PACKAGE_SCOPES).toContain("RAW_TELEMETRY");
  });

  it("recognizes only known scopes", () => {
    expect(isConsentScope("RAW_TELEMETRY")).toBe(true);
    expect(isConsentScope("ALL")).toBe(false);
    expect(isConsentScope("raw_telemetry")).toBe(false);
    expect(isConsentScope(undefined)).toBe(false);
  });
});

describe("agreement status", () => {
  it("is ACTIVE inside [effectiveFrom, expiresAt) and not outside it", () => {
    const a = agreement({
      effectiveFrom: new Date(T0).toISOString(),
      expiresAt: new Date(T0 + 1000).toISOString(),
    });
    expect(agreementStatus(a, T0 - 1)).toBe("NOT_YET_EFFECTIVE");
    expect(agreementStatus(a, T0)).toBe("ACTIVE");
    expect(agreementStatus(a, T0 + 999)).toBe("ACTIVE");
    expect(agreementStatus(a, T0 + 1000)).toBe("EXPIRED");
  });

  it("any revocation timestamp means REVOKED, even one that looks to be in the future", () => {
    expect(agreementStatus(agreement({ revokedAt: new Date(T0).toISOString() }), T0)).toBe(
      "REVOKED",
    );
    expect(agreementStatus(agreement({ revokedAt: new Date(T0 + 9e9).toISOString() }), T0)).toBe(
      "REVOKED",
    );
    expect(agreementStatus(agreement({ revokedAt: new Date(T0 - 9e9).toISOString() }), T0)).toBe(
      "REVOKED",
    );
  });

  it("is fail-closed on unparseable dates", () => {
    expect(agreementStatus(agreement({ effectiveFrom: "garbage" }), T0)).not.toBe("ACTIVE");
    expect(agreementStatus(agreement({ expiresAt: "garbage" }), T0)).not.toBe("ACTIVE");
  });
});

describe("evaluateAccess denies by default", () => {
  it("allows exactly the matching active agreement and reports the granted scopes in vocabulary order", () => {
    const d = evaluateAccess([agreement()], request());
    expect(d).toEqual({
      allowed: true,
      agreementIds: ["AGR-1"],
      grantedScopes: ["RECOMMENDATION", "VERIFICATION_RESULT"],
    });
  });

  it("denies with no agreement at all", () => {
    expect(evaluateAccess([], request())).toMatchObject({
      allowed: false,
      reason: "NO_AGREEMENT_FOR_TARGET",
      internalReason: "NO_AGREEMENT",
    });
  });

  it("denies the wrong recipient organization and the wrong owner", () => {
    expect(
      evaluateAccess([agreement()], request({ recipientOrganizationId: "ORG-X" })),
    ).toMatchObject({
      allowed: false,
      reason: "NO_AGREEMENT_FOR_TARGET",
    });
    expect(evaluateAccess([agreement()], request({ ownerOrganizationId: "ORG-X" }))).toMatchObject({
      allowed: false,
    });
  });

  it("denies a facility outside the agreement, with an internal reason distinct from 'no agreement'", () => {
    const d = evaluateAccess([agreement()], request({ facilityId: "FAC-2" }));
    expect(d).toMatchObject({
      allowed: false,
      reason: "NO_AGREEMENT_FOR_TARGET",
      internalReason: "FACILITY_NOT_IN_AGREEMENT",
    });
  });

  it("denies a scope that was not granted, and never infers one from another", () => {
    for (const requested of CONSENT_SCOPES.filter(
      (s) => s !== "VERIFICATION_RESULT" && s !== "RECOMMENDATION",
    )) {
      const d = evaluateAccess([agreement()], request({ anyOfScopes: [requested] }));
      expect(d, requested).toMatchObject({ allowed: false, reason: "SCOPE_NOT_GRANTED" });
    }
  });

  it("raw telemetry is never implied by every other scope together", () => {
    const everything = agreement({ scopes: [...EVIDENCE_CONSENT_SCOPES] });
    expect(evaluateAccess([everything], request({ anyOfScopes: ["RAW_TELEMETRY"] }))).toMatchObject(
      {
        allowed: false,
        reason: "SCOPE_NOT_GRANTED",
      },
    );
    const raw = agreement({ scopes: ["RAW_TELEMETRY"] });
    expect(evaluateAccess([raw], request({ anyOfScopes: ["RAW_TELEMETRY"] })).allowed).toBe(true);
    expect(evaluateAccess([raw], request({ anyOfScopes: ["VERIFICATION_RESULT"] })).allowed).toBe(
      false,
    );
  });

  it("denies revoked, expired and not-yet-effective agreements with distinct reasons", () => {
    expect(
      evaluateAccess([agreement({ revokedAt: new Date(T0 - 1).toISOString() })], request()),
    ).toMatchObject({
      reason: "AGREEMENT_REVOKED",
    });
    expect(
      evaluateAccess([agreement({ expiresAt: new Date(T0).toISOString() })], request()),
    ).toMatchObject({
      reason: "AGREEMENT_EXPIRED",
    });
    expect(
      evaluateAccess([agreement({ effectiveFrom: new Date(T0 + 1).toISOString() })], request()),
    ).toMatchObject({
      reason: "AGREEMENT_NOT_YET_EFFECTIVE",
    });
  });

  it("prefers revoked over expired over not-yet-effective when several apply", () => {
    const list = [
      agreement({ agreementId: "A1", expiresAt: new Date(T0 - 1).toISOString() }),
      agreement({ agreementId: "A2", revokedAt: new Date(T0 - 5).toISOString() }),
      agreement({ agreementId: "A3", effectiveFrom: new Date(T0 + 5).toISOString() }),
    ];
    expect(evaluateAccess(list, request())).toMatchObject({ reason: "AGREEMENT_REVOKED" });
    expect(evaluateAccess(list.slice(0, 1).concat(list.slice(2)), request())).toMatchObject({
      reason: "AGREEMENT_EXPIRED",
    });
  });

  it("one revoked agreement does not affect another active one; scopes are the union of the active ones", () => {
    const list = [
      agreement({
        agreementId: "A1",
        scopes: ["VERIFICATION_RESULT"],
        revokedAt: new Date(T0 - 1).toISOString(),
      }),
      agreement({ agreementId: "A2", scopes: ["RECOMMENDATION"] }),
      agreement({ agreementId: "A3", scopes: ["EVENT_SUMMARY"] }),
    ];
    expect(evaluateAccess(list, request({ anyOfScopes: ["RECOMMENDATION"] }))).toEqual({
      allowed: true,
      agreementIds: ["A2", "A3"],
      grantedScopes: ["RECOMMENDATION", "EVENT_SUMMARY"],
    });
    // the revoked agreement's scope is not part of the union
    expect(evaluateAccess(list, request({ anyOfScopes: ["VERIFICATION_RESULT"] }))).toMatchObject({
      allowed: false,
      reason: "SCOPE_NOT_GRANTED",
    });
  });

  it("an agreement of another recipient or tenant is ignored, even for the same facility", () => {
    const list = [
      agreement({ agreementId: "A1", recipientOrganizationId: "ORG-X" }),
      agreement({ agreementId: "A2", organizationId: "ORG-Z" }),
    ];
    expect(evaluateAccess(list, request())).toMatchObject({
      allowed: false,
      reason: "NO_AGREEMENT_FOR_TARGET",
    });
  });

  it("an empty scope request is never allowed", () => {
    expect(evaluateAccess([agreement()], request({ anyOfScopes: [] })).allowed).toBe(false);
  });
});

describe("deriveSharingState", () => {
  it("covers every combination of facts", () => {
    expect(
      deriveSharingState({
        hasPackage: false,
        activeAgreementReleasesPackage: true,
        everShared: true,
      }),
    ).toBe("NOT_SHARED");
    expect(
      deriveSharingState({
        hasPackage: true,
        activeAgreementReleasesPackage: false,
        everShared: false,
      }),
    ).toBe("SHAREABLE");
    expect(
      deriveSharingState({
        hasPackage: true,
        activeAgreementReleasesPackage: true,
        everShared: false,
      }),
    ).toBe("SHARED");
    expect(
      deriveSharingState({
        hasPackage: true,
        activeAgreementReleasesPackage: true,
        everShared: true,
      }),
    ).toBe("SHARED");
    expect(
      deriveSharingState({
        hasPackage: true,
        activeAgreementReleasesPackage: false,
        everShared: true,
      }),
    ).toBe("REVOKED");
  });

  it("a package alone is never SHARED", () => {
    expect(
      deriveSharingState({
        hasPackage: true,
        activeAgreementReleasesPackage: false,
        everShared: false,
      }),
    ).not.toBe("SHARED");
  });
});
