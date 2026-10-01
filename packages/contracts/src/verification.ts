import type { IsoTimestamp, TimeWindow } from "./primitives";

export const VERIFICATION_RESULTS = [
  "VERIFIED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const CRITERION_ROLES = ["REQUIRED", "SUPPORTING"] as const;
export type CriterionRole = (typeof CRITERION_ROLES)[number];

/**
 * PASS: trustworthy evidence meets the policy. FAIL: trustworthy evidence shows it does not.
 * INSUFFICIENT: the evidence cannot establish either (missing, stale, untrusted). INSUFFICIENT is
 * never the same as FAIL: it leads to INCONCLUSIVE, not NOT_IMPROVING.
 */
export const CRITERION_OUTCOMES = ["PASS", "FAIL", "INSUFFICIENT"] as const;
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];

export type CriterionStat = {
  readonly sampleCount: number;
  readonly mean?: number;
  readonly min?: number;
  readonly max?: number;
};

/**
 * Outcome of one verification criterion. `criterionId` and `passed` are the S1 minimum; the S5
 * engine always fills the rest so the result can be explained without any generated language.
 * `passed` is true only for outcome PASS.
 */
export type CriterionResult = {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly description?: string;
  readonly role?: CriterionRole;
  readonly outcome?: CriterionOutcome;
  readonly assetId?: string;
  readonly signal?: string;
  /** Unit of `observedMetric` and of the thresholds, e.g. "z_score", "percent_deviation". */
  readonly metric?: string;
  /** Learned reference the observations were compared with. */
  readonly reference?: {
    readonly baselineIds: readonly string[];
    readonly operatingModes: readonly string[];
    readonly mean?: number;
  };
  /** Raw signal values before the action (pre-action lookback window). */
  readonly before?: CriterionStat;
  /** Raw trusted signal values after the action (sustained interval). */
  readonly observed?: CriterionStat;
  /** Deviation metric after the action (against the reference). */
  readonly observedMetric?: CriterionStat;
  readonly thresholds?: Readonly<Record<string, number>>;
  readonly reasonCodes?: readonly string[];
  readonly evidenceIds?: readonly string[];
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
  /** Deterministic reason codes explaining the result (S5). */
  readonly reasonCodes?: readonly string[];
};

export const EVIDENCE_KINDS = [
  "OBSERVATION",
  "BASELINE",
  "ACTION",
  "AUDIT",
  "POLICY",
  "DEVICE",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A typed pointer to a record that really exists; S6 will assemble these into packages. */
export type EvidenceReference = { readonly id: string; readonly kind: EvidenceKind };

export const VERIFICATION_STATUSES = ["IN_PROGRESS", "COMPLETED"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type RequiredSignal = {
  readonly criterionId: string;
  readonly assetId: string;
  readonly signal: string;
  readonly role: CriterionRole;
};

/**
 * One verification attempt, tied to one case, one risk event and one action cycle. Attempts are
 * never overwritten once COMPLETED, so a case keeps its whole verification history.
 */
export type VerificationAttempt = {
  readonly verificationId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly caseId: string;
  readonly eventId: string;
  readonly policyId: string;
  readonly policyVersion: string;
  /** Reported actions of this cycle. */
  readonly actionIds: readonly string[];
  readonly actionLibraryIds: readonly string[];
  readonly postActionWindow: TimeWindow;
  readonly requiredAssetIds: readonly string[];
  readonly requiredSignals: readonly RequiredSignal[];
  readonly startedAt: IsoTimestamp;
  /** The `verification.started` event of this attempt, once emitted. */
  readonly startedEventId?: string;
  readonly correlationId: string;
  readonly status: VerificationStatus;
  readonly evaluatedAt?: IsoTimestamp;
  readonly assessment?: VerificationAssessment;
  readonly evidenceReferences?: readonly EvidenceReference[];
  /** Set when the result is VERIFIED: the hazard returning before this is a recurrence. */
  readonly recurrenceWatchEndsAt?: IsoTimestamp;
};
