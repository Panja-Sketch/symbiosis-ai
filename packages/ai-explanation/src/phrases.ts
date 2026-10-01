/**
 * Static wording for deterministic codes. Unknown codes fall back to a readable form of the code
 * itself. These tables are what makes the template provider good, and they are the same words the
 * grounding rules treat as established.
 */

export const humanize = (code: string): string => code.toLowerCase().replace(/_/g, " ");

export const RESULT_LABELS: Readonly<Record<string, string>> = {
  VERIFIED: "Verified improved",
  PARTIALLY_VERIFIED: "Partially verified",
  NOT_IMPROVING: "Not improving",
  INCONCLUSIVE: "Inconclusive",
};

/** What each result means, in words that never say more than the verification engine concluded. */
export const RESULT_MEANING: Readonly<Record<string, string>> = {
  VERIFIED:
    "trusted sensor readings after the action met every required criterion of the verification policy",
  PARTIALLY_VERIFIED:
    "trusted readings improved materially but did not reach the policy target for every required criterion",
  NOT_IMPROVING:
    "trusted readings show the condition still does not meet the policy after the reported action",
  INCONCLUSIVE:
    "the available evidence could not establish whether the condition improved (missing, stale or untrusted data)",
};

export const DETECTION_REASONS: Readonly<Record<string, string>> = {
  VIBRATION_Z_AT_OR_ABOVE_THRESHOLD: "vibration was well above its learned baseline",
  CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD: "electrical current was above its learned baseline",
  OUTDOOR_HEAT_CONTEXT: "outdoor heat was above the configured limit",
  ZONE_TEMPERATURE_RISING: "the zone temperature was rising",
};
export function detectionReason(code: string): string {
  const p = /^PERSISTED_(\d+)_OF_(\d+)$/.exec(code);
  if (p) return `the pattern persisted for ${p[1]} of ${p[2]} required checks`;
  return DETECTION_REASONS[code] ?? humanize(code);
}

export const VERIFICATION_REASONS: Readonly<Record<string, string>> = {
  ALL_REQUIRED_CRITERIA_PASSED: "every required criterion passed",
  SUSTAINED_WITHIN_TARGET: "readings stayed within target for the required period",
  SUSTAINED_IMPROVEMENT_TARGET_NOT_MET: "readings improved but were not sustained within target",
  IMPROVED_BUT_NOT_AT_TARGET: "readings improved but are not at target",
  PARTIAL_IMPROVEMENT_NOT_AT_TARGET: "improvement was partial and the target was not reached",
  STILL_MATERIALLY_ABNORMAL: "readings are still materially abnormal",
  TRUSTED_EVIDENCE_SHOWS_NO_IMPROVEMENT: "trusted evidence shows no improvement",
  DATA_COMPLETE_AND_FRESH: "the data was complete and fresh",
  DEVICES_HEALTHY_AND_AUTHENTICATED: "the devices were healthy and authenticated",
  ZONE_TEMPERATURE_STABLE_OR_FALLING: "the zone temperature was stable or falling",
  ZONE_TEMPERATURE_INSUFFICIENT_SAMPLES:
    "there were too few temperature samples to judge the trend",
  BACKUP_OBSERVED_RUNNING: "backup capacity was observed running",
  BACKUP_NOT_OBSERVED_RUNNING: "backup capacity was not observed running",
  INSUFFICIENT_OBSERVATIONS: "there were too few trusted observations",
  INSUFFICIENT_OBSERVATIONS_IN_SUSTAINED_INTERVAL:
    "there were too few observations in the sustained interval",
  GAP_IN_SUSTAINED_INTERVAL: "a gap in the data broke the sustained interval",
  NO_TRUSTED_OBSERVATIONS: "no trusted observations arrived after the action",
  REQUIRED_SIGNAL_MISSING: "a required signal was missing",
  STALE_REQUIRED_TELEMETRY: "required telemetry was stale",
  MISSINGNESS_EXCEEDS_LIMIT: "too much data was missing",
  MISSING_INTERVAL_EXCEEDS_LIMIT: "a data gap exceeded the limit",
  LOW_TELEMETRY_CONFIDENCE: "telemetry confidence was too low",
  LOW_CONFIDENCE: "confidence was too low",
  DEVICE_NOT_HEALTHY: "a required device was not healthy",
  EVIDENCE_INSUFFICIENT_TO_ESTABLISH_OUTCOME:
    "the evidence was insufficient to establish the outcome",
  EVIDENCE_UNTRUSTED_OR_DEVICE_INTEGRITY_NOT_ESTABLISHED:
    "the evidence was untrusted or device integrity was not established",
};
export const verificationReason = (c: string): string => VERIFICATION_REASONS[c] ?? humanize(c);

export const CRITERION_LABELS: Readonly<Record<string, string>> = {
  VIBRATION: "vibration back within target",
  CURRENT: "electrical current back within target",
  DATA_QUALITY: "data completeness and freshness",
  DEVICE_INTEGRITY: "device health and authenticity",
  ZONE_TEMPERATURE_SLOPE: "zone temperature trend",
  BACKUP_CAPACITY: "backup capacity",
};
export const criterionLabel = (id: string): string => CRITERION_LABELS[id] ?? humanize(id);

export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  PASS: "passed",
  FAIL: "failed",
  PARTIAL: "was partial",
  INCONCLUSIVE: "was inconclusive",
};
export const outcomeLabel = (o: string): string => OUTCOME_LABELS[o] ?? humanize(o);

export const INTERVENTION_LABELS: Readonly<Record<string, string>> = {
  REMOTE_MONITORING: "Remote Monitoring",
  REMOTE_REVIEW: "Remote Review",
  RISK_ENGINEER_REVIEW: "Risk Engineer Review",
  SITE_VISIT_RECOMMENDED: "Site Visit Recommended",
};
export const interventionLabel = (l: string): string => INTERVENTION_LABELS[l] ?? humanize(l);

export const INTERVENTION_MEANING: Readonly<Record<string, string>> = {
  REMOTE_MONITORING: "keep watching the verified evidence; no review is recommended right now",
  REMOTE_REVIEW: "a person at the insurer may want to look at the evidence remotely",
  RISK_ENGINEER_REVIEW:
    "a risk engineer is recommended to review the evidence and the case history",
  SITE_VISIT_RECOMMENDED:
    "a site visit is recommended; Symbiosis does not arrange visits or assign anyone",
};

export const INTERVENTION_REASONS: Readonly<Record<string, string>> = {
  NO_ESCALATION_CONDITION_MET: "no escalation condition is met",
  IMPROVEMENT_CONFIRMED_UNDER_RECURRENCE_WATCH:
    "the improvement was verified and recurrence is being watched",
  HIGH_SEVERITY_UNRESOLVED: "a high-severity risk is unresolved",
  CRITICAL_SEVERITY_UNRESOLVED: "a critical-severity risk is unresolved",
  ACKNOWLEDGEMENT_ESCALATED: "the alert was not acknowledged in time",
  LATEST_VERIFICATION_PARTIAL: "the latest verification was only partial",
  LATEST_VERIFICATION_NOT_IMPROVING: "the latest verification showed no improvement",
  LATEST_VERIFICATION_INCONCLUSIVE: "the latest verification was inconclusive",
  REPEATED_INCONCLUSIVE_VERIFICATION: "verification was inconclusive more than once",
  TWO_CONSECUTIVE_UNSUCCESSFUL_VERIFICATIONS: "two verifications in a row were unsuccessful",
  THREE_CONSECUTIVE_UNSUCCESSFUL_VERIFICATIONS: "three verifications in a row were unsuccessful",
  RECURRED_AFTER_VERIFIED_IMPROVEMENT: "the hazard returned after a verified improvement",
  RECURRED_TWICE_AFTER_VERIFIED_IMPROVEMENT:
    "the hazard returned twice after a verified improvement",
  CRITICAL_RISK_NOT_IMPROVING: "a critical risk is not improving",
  INSUFFICIENT_REMOTE_EVIDENCE: "remote evidence is not sufficient to judge",
  CRITICAL_UNRESOLVED_WITH_INSUFFICIENT_REMOTE_EVIDENCE:
    "a critical risk is unresolved and remote evidence is insufficient",
  DEVICE_OR_AUTH_INTEGRITY_ISSUE: "a device or authenticity problem limits the evidence",
};
export const interventionReason = (c: string): string => INTERVENTION_REASONS[c] ?? humanize(c);

export const HAZARD_LABELS: Readonly<Record<string, string>> = {
  COOLING_ELECTRICAL_DETERIORATION: "cooling and electrical deterioration",
};
export const hazardLabel = (h: string): string => HAZARD_LABELS[h] ?? humanize(h);

export const STATE_LABELS: Readonly<Record<string, string>> = {
  OPEN: "open (risk detected)",
  ACTION_REQUIRED: "action required",
  ACTION_REPORTED: "action reported, verification pending",
  VERIFYING: "verification in progress",
  VERIFIED_IMPROVED: "verified improved",
  PARTIALLY_VERIFIED: "partially verified",
  NOT_IMPROVING: "not improving",
  INCONCLUSIVE: "inconclusive",
  CLOSED: "closed",
  REOPENED: "reopened after a recurrence",
};
export const stateLabel = (s: string): string => STATE_LABELS[s] ?? humanize(s);

export const SHARING_LABELS: Readonly<Record<string, string>> = {
  NOT_SHARED: "not shared (no evidence package yet)",
  SHAREABLE: "shareable (a package exists; nothing shared with anyone)",
  SHARED: "shared under an active agreement",
  REVOKED: "revoked (no active agreement remains)",
};
export const sharingLabel = (s: string): string => SHARING_LABELS[s] ?? humanize(s);

export const SCOPE_LABELS: Readonly<Record<string, string>> = {
  RECOMMENDATION: "risk summary",
  EVENT_SUMMARY: "what was detected",
  ACTION_SUMMARY: "actions reported",
  BEFORE_AFTER_METRICS: "before and after measurements",
  VERIFICATION_RESULT: "verification outcome",
  VERIFICATION_CONFIDENCE: "confidence and completeness",
  RECURRENCE_STATUS: "recurrence status",
  EVIDENCE_ARTIFACTS: "evidence package details",
  INTERVENTION_RECOMMENDATION: "risk-engineer recommendation",
};

export const formatNumber = (n: number | undefined): string =>
  n === undefined ? "unavailable" : String(Number(n.toPrecision(4)));
export const formatPercent = (n: number | undefined): string =>
  n === undefined ? "unavailable" : `${Math.round(n * 100)}%`;
