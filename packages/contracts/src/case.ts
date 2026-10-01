import type { IsoTimestamp } from "./primitives";

export const CASE_SEVERITIES = ["LOW", "MODERATE", "HIGH", "CRITICAL"] as const;
export type CaseSeverity = (typeof CASE_SEVERITIES)[number];

export const CASE_STATES = [
  "OPEN",
  "ACTION_REQUIRED",
  "ACTION_REPORTED",
  "VERIFYING",
  "VERIFIED_IMPROVED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
  "CLOSED",
  "REOPENED",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const SHARING_STATES = ["NOT_SHARED", "SHAREABLE", "SHARED", "REVOKED"] as const;
export type SharingState = (typeof SHARING_STATES)[number];

export type CaseOrigin =
  | { readonly type: "RECOMMENDATION"; readonly recommendationId: string }
  | { readonly type: "DETECTED_HAZARD"; readonly detectionId: string }
  | { readonly type: "MANUAL_RISK_REVIEW"; readonly reviewId: string };

export type RiskImprovementCase = {
  readonly caseId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetIds: readonly string[];

  readonly origin: CaseOrigin;

  readonly hazardType: string;
  readonly title: string;
  readonly severity: CaseSeverity;

  readonly baselineSnapshotId?: string;
  readonly activeRiskEventId?: string;

  readonly assignedOwnerId?: string;
  readonly targetDate?: string;

  readonly state: CaseState;

  readonly latestVerificationId?: string;
  readonly latestEvidencePackageId?: string;

  readonly recurrenceCount: number;
  readonly sharingState: SharingState;

  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};
