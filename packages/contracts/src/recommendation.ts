export const RECOMMENDATION_SOURCES = ["INSURER", "FACILITY", "SYMBIOSIS", "IMPORTED"] as const;
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];

export const RECOMMENDATION_STATUSES = [
  "OPEN",
  "ACTION_REPORTED",
  "VERIFYING",
  "VERIFIED",
  "PARTIAL",
  "UNVERIFIED",
  "CLOSED",
  "REOPENED",
] as const;
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

/** `CLOSED` is administrative and must never be treated as `VERIFIED`. */
export type RiskRecommendation = {
  readonly recommendationId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly source: RecommendationSource;
  readonly sourceReference?: string;
  readonly hazardType: string;
  readonly description: string;
  readonly approvedActionIds: readonly string[];
  readonly targetDate?: string;
  readonly verificationPolicyId?: string;
  readonly status: RecommendationStatus;
};
