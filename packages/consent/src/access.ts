import { CONSENT_SCOPES } from "@symbiosis/contracts";
import type {
  AgreementStatus,
  ConsentScope,
  SharingAgreement,
  SharingState,
} from "@symbiosis/contracts";

/**
 * Scopes that release the evidence package itself (or part of it). RECOMMENDATION and
 * INTERVENTION_RECOMMENDATION do not: an agreement that grants only those shares no package.
 */
export const EVIDENCE_PACKAGE_SCOPES: readonly ConsentScope[] = [
  "EVENT_SUMMARY",
  "ACTION_SUMMARY",
  "BEFORE_AFTER_METRICS",
  "VERIFICATION_RESULT",
  "VERIFICATION_CONFIDENCE",
  "RECURRENCE_STATUS",
  "EVIDENCE_ARTIFACTS",
  "RAW_TELEMETRY",
];

export const isConsentScope = (v: unknown): v is ConsentScope =>
  typeof v === "string" && (CONSENT_SCOPES as readonly string[]).includes(v);

/**
 * Status of an agreement at `nowMs`. Fail-closed: any revocation timestamp (even one that looks
 * to be in the future) means REVOKED, and an unparseable date means the agreement is not active.
 * Revocation applies from the instant it is recorded: `revokedAt <= now` is not required.
 */
export function agreementStatus(a: SharingAgreement, nowMs: number): AgreementStatus {
  if (a.revokedAt !== undefined) return "REVOKED";
  const from = Date.parse(a.effectiveFrom);
  if (Number.isNaN(from) || nowMs < from) return "NOT_YET_EFFECTIVE";
  if (a.expiresAt !== undefined) {
    const to = Date.parse(a.expiresAt);
    if (Number.isNaN(to) || nowMs >= to) return "EXPIRED";
  }
  return "ACTIVE";
}

/** Reasons exposed to the caller. They never reveal whether an unrelated target exists. */
export type DenialReason =
  | "NO_AGREEMENT_FOR_TARGET"
  | "AGREEMENT_REVOKED"
  | "AGREEMENT_EXPIRED"
  | "AGREEMENT_NOT_YET_EFFECTIVE"
  | "SCOPE_NOT_GRANTED";

export type AccessRequest = {
  /** From the authenticated actor, never from the request. */
  readonly recipientOrganizationId: string;
  /** The organization that owns the data being read. */
  readonly ownerOrganizationId: string;
  readonly facilityId: string;
  /** Allowed when the active agreements grant at least one of these scopes. */
  readonly anyOfScopes: readonly ConsentScope[];
  readonly nowMs: number;
};

export type AccessDecision =
  | {
      readonly allowed: true;
      readonly agreementIds: readonly string[];
      /** Union of the scopes of every active agreement covering the facility. */
      readonly grantedScopes: readonly ConsentScope[];
    }
  | {
      readonly allowed: false;
      readonly reason: DenialReason;
      /** Finer detail for the audit trail only (not shown to the caller). */
      readonly internalReason: string;
    };

const scopeOrder = (s: ConsentScope) => CONSENT_SCOPES.indexOf(s);

/**
 * The consent gateway decision, as a pure function over the recipient's agreements. It checks
 * recipient organization, facility coverage, effective/expiry window, revocation and scope, and
 * it denies by default: no agreement, no match, or any doubt means DENIED. Nothing about a
 * failure can turn into an allow, because "allowed" is only ever returned from the last branch.
 */
export function evaluateAccess(
  agreements: readonly SharingAgreement[],
  request: AccessRequest,
): AccessDecision {
  const sameParties = agreements.filter(
    (a) =>
      a.organizationId === request.ownerOrganizationId &&
      a.recipientOrganizationId === request.recipientOrganizationId,
  );
  if (sameParties.length === 0) {
    return { allowed: false, reason: "NO_AGREEMENT_FOR_TARGET", internalReason: "NO_AGREEMENT" };
  }
  const covering = sameParties.filter((a) => a.facilityIds.includes(request.facilityId));
  if (covering.length === 0) {
    return {
      allowed: false,
      reason: "NO_AGREEMENT_FOR_TARGET",
      internalReason: "FACILITY_NOT_IN_AGREEMENT",
    };
  }
  const statuses = covering.map((a) => ({ a, status: agreementStatus(a, request.nowMs) }));
  const active = statuses.filter((s) => s.status === "ACTIVE").map((s) => s.a);
  if (active.length === 0) {
    const has = (st: AgreementStatus) => statuses.some((s) => s.status === st);
    if (has("REVOKED")) {
      return { allowed: false, reason: "AGREEMENT_REVOKED", internalReason: "REVOKED" };
    }
    if (has("EXPIRED")) {
      return { allowed: false, reason: "AGREEMENT_EXPIRED", internalReason: "EXPIRED" };
    }
    return {
      allowed: false,
      reason: "AGREEMENT_NOT_YET_EFFECTIVE",
      internalReason: "NOT_YET_EFFECTIVE",
    };
  }
  const granted = [...new Set(active.flatMap((a) => a.scopes))].sort(
    (x, y) => scopeOrder(x) - scopeOrder(y),
  );
  if (!request.anyOfScopes.some((s) => granted.includes(s))) {
    return {
      allowed: false,
      reason: "SCOPE_NOT_GRANTED",
      internalReason: `SCOPE_NOT_GRANTED:${request.anyOfScopes.join("|")}`,
    };
  }
  return { allowed: true, agreementIds: active.map((a) => a.agreementId), grantedScopes: granted };
}

/**
 * The case-level sharing state, derived from facts rather than set by hand (D-048):
 * NOT_SHARED: no evidence package. SHARED: an active agreement releases the package.
 * REVOKED: it was shared at some point and nothing active remains. SHAREABLE: a package exists
 * and nothing has ever been shared. A package alone never means SHARED.
 */
export function deriveSharingState(facts: {
  readonly hasPackage: boolean;
  readonly activeAgreementReleasesPackage: boolean;
  readonly everShared: boolean;
}): SharingState {
  if (!facts.hasPackage) return "NOT_SHARED";
  if (facts.activeAgreementReleasesPackage) return "SHARED";
  return facts.everShared ? "REVOKED" : "SHAREABLE";
}
