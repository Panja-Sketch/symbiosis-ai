import type { CaseDto } from "./types";

/**
 * Counting and filtering over cases the API already returned. These are presentation groupings of
 * backend states and fields (what the summary cards count), not rules about risk.
 */

export type OperationsSummary = {
  readonly open: number;
  readonly actionRequired: number;
  readonly verificationPending: number;
  readonly verifiedImproved: number;
  readonly recurrence: number;
  readonly needsReview: number;
};

/** Unsuccessful outcomes stay open and need a human follow-up, so they count as action required. */
const ACTION_STATES: readonly string[] = [
  "OPEN",
  "ACTION_REQUIRED",
  "REOPENED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
];
const PENDING_STATES: readonly string[] = ["ACTION_REPORTED", "VERIFYING"];
const REVIEW_LEVELS: readonly string[] = ["RISK_ENGINEER_REVIEW", "SITE_VISIT_RECOMMENDED"];

export function summarizeCases(cases: readonly CaseDto[]): OperationsSummary {
  return {
    open: cases.filter((c) => c.state !== "CLOSED").length,
    actionRequired: cases.filter((c) => ACTION_STATES.includes(c.state)).length,
    verificationPending: cases.filter((c) => PENDING_STATES.includes(c.state)).length,
    verifiedImproved: cases.filter((c) => c.state === "VERIFIED_IMPROVED").length,
    recurrence: cases.filter((c) => c.state === "REOPENED" || c.stayingFixed.recurrenceCount > 0)
      .length,
    needsReview: cases.filter(
      (c) => c.intervention !== undefined && REVIEW_LEVELS.includes(c.intervention.level),
    ).length,
  };
}

export type CaseFilters = {
  readonly state?: string;
  readonly severity?: string;
  readonly facility?: string;
  readonly verification?: string;
};

export function filterCases(cases: readonly CaseDto[], f: CaseFilters): readonly CaseDto[] {
  return cases.filter(
    (c) =>
      (f.state === undefined || c.state === f.state) &&
      (f.severity === undefined || c.severity === f.severity) &&
      (f.facility === undefined || c.facilityId === f.facility) &&
      (f.verification === undefined || c.didItWork.status === f.verification),
  );
}

/** One query-string value, or undefined for empty / repeated / "all". */
export function param(v: string | readonly string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" && s !== "" && s !== "ALL" ? s : undefined;
}

export const lastUpdate = (c: CaseDto): string | undefined => c.evidence.auditReferences.at(-1)?.at;
