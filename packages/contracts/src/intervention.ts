import type { CaseSeverity } from "./case";
import type { IsoTimestamp } from "./primitives";

export const INTERVENTION_LEVELS = [
  "REMOTE_MONITORING",
  "REMOTE_REVIEW",
  "RISK_ENGINEER_REVIEW",
  "SITE_VISIT_RECOMMENDED",
] as const;
export type InterventionLevel = (typeof INTERVENTION_LEVELS)[number];

export const INTERVENTION_STATUSES = ["ACTIVE", "ACKNOWLEDGED", "RESOLVED", "SUPERSEDED"] as const;
export type InterventionStatus = (typeof INTERVENTION_STATUSES)[number];

/**
 * Deterministic decision support for risk-engineering teams (spec 23A). It never schedules or
 * dispatches anyone, and never changes underwriting, premium or coverage.
 */
export type RiskEngineerInterventionRecommendation = {
  readonly interventionId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId?: string;
  readonly level: InterventionLevel;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly supportingEvidenceIds: readonly string[];
  readonly dataSufficiency: number;
  readonly generatedAt: IsoTimestamp;
  readonly status: InterventionStatus;
  readonly supersededBy?: string;
  readonly acknowledgedBy?: string;
  readonly acknowledgedAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
};

/** Trusted facts the prioritization policy may use; nothing personal, nothing generated. */
export type InterventionFacts = {
  readonly caseSeverity: CaseSeverity;
  readonly caseState: string;
  readonly caseUnresolved: boolean;
  readonly latestVerificationResult: string;
  readonly notImprovingCount: number;
  readonly partiallyVerifiedCount: number;
  readonly inconclusiveCount: number;
  readonly consecutiveUnsuccessfulVerifications: number;
  readonly recurrenceCount: number;
  readonly escalated: boolean;
  readonly dataSufficiency: number;
  readonly telemetryConfidence: number;
  readonly integrityIssue: boolean;
  readonly corroboratingSignals: number;
  readonly insufficientRemoteEvidence: boolean;
};
