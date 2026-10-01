import type { IsoTimestamp } from "./primitives";

/**
 * What an insured can authorize an insurer to see (spec 20.2). RAW_TELEMETRY is a separate,
 * explicit scope that no other scope implies. INTERVENTION_RECOMMENDATION is an S6 addition
 * (D-050): the deterministic prioritization output reveals verification and recurrence facts,
 * so it needs its own consent.
 */
export const CONSENT_SCOPES = [
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
] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];

/** Everything except raw telemetry: the broad, evidence-oriented grant. */
export const EVIDENCE_CONSENT_SCOPES: readonly ConsentScope[] = CONSENT_SCOPES.filter(
  (s) => s !== "RAW_TELEMETRY",
);

export type SharingAgreement = {
  readonly agreementId: string;
  /** The insured/customer organization that grants access (derived server-side). */
  readonly organizationId: string;
  readonly recipientOrganizationId: string;
  readonly scopes: readonly ConsentScope[];
  readonly facilityIds: readonly string[];
  readonly effectiveFrom: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly revokedAt?: IsoTimestamp;
  readonly createdBy: string;
  readonly createdAt: IsoTimestamp;
  readonly revokedBy?: string;
  readonly revocationReason?: string;
};

/** Ledger of "this package became available to this recipient under this agreement". */
export type SharedEvidenceRecord = {
  readonly shareId: string;
  readonly agreementId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId: string;
  readonly evidencePackageId: string;
  readonly recipientOrganizationId: string;
  readonly sharedAt: IsoTimestamp;
};

export const AGREEMENT_STATUSES = ["NOT_YET_EFFECTIVE", "ACTIVE", "EXPIRED", "REVOKED"] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
