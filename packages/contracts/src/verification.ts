import type { IsoTimestamp, TimeWindow } from "./primitives";

export const VERIFICATION_RESULTS = [
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

/** Outcome of one verification criterion. Structure is minimal; evaluation is S5. */
export type CriterionResult = {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly description?: string;
};

export type VerificationAssessment = {
  readonly verificationId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly policyId: string;
  readonly policyVersion: string;

  readonly baselineWindow: TimeWindow;
  readonly postActionWindow: TimeWindow;

  readonly requiredCriteria: readonly CriterionResult[];
  readonly supportingCriteria: readonly CriterionResult[];

  readonly dataCompleteness: number;
  readonly telemetryConfidence: number;
  readonly deviceHealthStatus: string;
  readonly authIntegrityStatus: string;

  readonly result: VerificationResult;
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly evaluatedAt: IsoTimestamp;
};
