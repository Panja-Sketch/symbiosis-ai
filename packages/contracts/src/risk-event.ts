import type { IsoTimestamp } from "./primitives";

export const RISK_EVENT_STATES = [
  "DETECTED",
  "ALERTED",
  "ACKNOWLEDGED",
  "ACTION_REPORTED",
  "VERIFYING",
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
  "ESCALATED",
  "SELF_RESOLVED",
  "DISMISSED_FALSE_ALARM",
] as const;
export type RiskEventState = (typeof RISK_EVENT_STATES)[number];

/** A physical-risk episode within a case (spec section 6). */
export type RiskEvent = {
  readonly eventId: string;
  readonly caseId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly state: RiskEventState;
  readonly latestVerificationId?: string;
  readonly detectedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
};
