import type { SiteWithCases } from "./loaders";
import type { InsurerCaseDto, InsurerInterventionDto } from "./types";

/**
 * Counting over the consent-filtered projections the insurer API returned. A field that the
 * sharing agreement does not cover is simply absent, and an absent field is never counted as a
 * result: it stays "not shared".
 */

export type RiskEvidenceSummary = {
  readonly sites: number;
  readonly cases: number;
  readonly open: number;
  readonly verified: number;
  readonly partial: number;
  readonly notImproving: number;
  readonly inconclusive: number;
  readonly recurrence: number;
  readonly needsReview: number;
  readonly evidenceMissing: number;
};

const REVIEW_LEVELS: readonly string[] = ["RISK_ENGINEER_REVIEW", "SITE_VISIT_RECOMMENDED"];

/** The current (not superseded) recommendation of each case, by case id. */
export function currentInterventions(
  all: readonly InsurerInterventionDto[],
): ReadonlyMap<string, InsurerInterventionDto> {
  const m = new Map<string, InsurerInterventionDto>();
  for (const i of all) {
    if (i.caseId !== undefined && i.status !== "SUPERSEDED" && i.status !== "RESOLVED") {
      m.set(i.caseId, i);
    }
  }
  return m;
}

export const hasRecurred = (c: InsurerCaseDto): boolean =>
  (c.recurrence?.currentRecurrenceCount ?? 0) > 0 ||
  c.recurrence?.reopenedSincePackage === true ||
  c.recommendation?.caseState === "REOPENED";

export function summarizeRiskEvidence(
  sites: readonly SiteWithCases[],
  interventions: readonly InsurerInterventionDto[],
): RiskEvidenceSummary {
  const cases = sites.flatMap((s) => s.cases);
  const result = (r: string) => cases.filter((c) => c.verification?.result === r).length;
  const current = [...currentInterventions(interventions).values()];
  return {
    sites: sites.length,
    cases: cases.length,
    open: cases.filter((c) => c.recommendation?.caseState !== "CLOSED").length,
    verified: result("VERIFIED"),
    partial: result("PARTIALLY_VERIFIED"),
    notImproving: result("NOT_IMPROVING"),
    inconclusive: result("INCONCLUSIVE"),
    recurrence: cases.filter(hasRecurred).length,
    needsReview: current.filter((i) => REVIEW_LEVELS.includes(i.level)).length,
    evidenceMissing: cases.filter((c) => c.evidenceAvailable === false).length,
  };
}
