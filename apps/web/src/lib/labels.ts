import { humanizeCode } from "./format";
import type { CaseState, ConsentScope, DidItWorkStatus, InterventionLevel } from "./types";

/**
 * Static, deterministic wording and visual semantics. Nothing here decides anything: every key is
 * a value the backend already produced, and an unknown value falls back to a readable form of the
 * code itself rather than being guessed at.
 */

// ---- the central visual language ------------------------------------------------------------

export type StatusKey =
  | "RISK_DETECTED"
  | "ACTION_REQUIRED"
  | "VERIFICATION_PENDING"
  | "VERIFIED_IMPROVED"
  | "PARTIALLY_VERIFIED"
  | "NOT_IMPROVING"
  | "INCONCLUSIVE"
  | "REOPENED"
  | "CLOSED";

export type Tone = "danger" | "warn" | "info" | "good" | "neutral";

export type FlowStage = "DETECT" | "UNDERSTAND" | "ACT" | "VERIFY" | "PROVE" | "MONITOR";
export const FLOW_STAGES: readonly FlowStage[] = [
  "DETECT",
  "UNDERSTAND",
  "ACT",
  "VERIFY",
  "PROVE",
  "MONITOR",
];

export type StatusInfo = {
  readonly label: string;
  /** A glyph and a label always travel together: colour is never the only signal. */
  readonly icon: string;
  readonly tone: Tone;
  readonly stage: FlowStage;
  readonly meaning: string;
};

export const STATUS: Readonly<Record<StatusKey, StatusInfo>> = {
  RISK_DETECTED: {
    label: "Risk detected",
    icon: "!",
    tone: "danger",
    stage: "DETECT",
    meaning:
      "The system detected a persistent risk pattern and opened a case. Nobody has acted yet.",
  },
  ACTION_REQUIRED: {
    label: "Action required",
    icon: "▲",
    tone: "warn",
    stage: "ACT",
    meaning: "A person has acknowledged the risk. An approved mitigation action is still needed.",
  },
  VERIFICATION_PENDING: {
    label: "Action reported · verification pending",
    icon: "◔",
    tone: "info",
    stage: "VERIFY",
    meaning:
      "A person reported an action. That is not proof the risk went down: sensors must show it.",
  },
  VERIFIED_IMPROVED: {
    label: "Verified improved",
    icon: "✓",
    tone: "good",
    stage: "PROVE",
    meaning: "Trusted sensor readings after the action met every required criterion.",
  },
  PARTIALLY_VERIFIED: {
    label: "Partially verified",
    icon: "◐",
    tone: "warn",
    stage: "PROVE",
    meaning: "Readings improved materially but did not reach the target everywhere.",
  },
  NOT_IMPROVING: {
    label: "Not improving",
    icon: "✕",
    tone: "danger",
    stage: "PROVE",
    meaning: "Trusted readings show the condition still does not meet the policy.",
  },
  INCONCLUSIVE: {
    label: "Inconclusive",
    icon: "?",
    tone: "neutral",
    stage: "PROVE",
    meaning: "The evidence could not establish whether the condition improved.",
  },
  REOPENED: {
    label: "Reopened · recurring",
    icon: "↻",
    tone: "danger",
    stage: "DETECT",
    meaning: "The hazard returned after a verified improvement. The same case was reopened.",
  },
  CLOSED: {
    label: "Closed",
    icon: "–",
    tone: "neutral",
    stage: "MONITOR",
    meaning: "The case is closed.",
  },
};

/** 1:1 presentation of the backend case state. */
export const STATUS_FOR_STATE: Readonly<Record<CaseState, StatusKey>> = {
  OPEN: "RISK_DETECTED",
  ACTION_REQUIRED: "ACTION_REQUIRED",
  ACTION_REPORTED: "VERIFICATION_PENDING",
  VERIFYING: "VERIFICATION_PENDING",
  VERIFIED_IMPROVED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
  CLOSED: "CLOSED",
  REOPENED: "REOPENED",
};

export const statusForState = (state: string): StatusInfo & { readonly key: StatusKey } => {
  const key = STATUS_FOR_STATE[state as CaseState] ?? "CLOSED";
  return { key, ...STATUS[key] };
};

/** The "Did it work?" answer uses the same visual language. */
export const STATUS_FOR_DID_IT_WORK: Readonly<Partial<Record<DidItWorkStatus, StatusKey>>> = {
  VERIFICATION_PENDING: "VERIFICATION_PENDING",
  VERIFIED_IMPROVED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

/** Verification results as the insurer API names them (`VERIFIED` rather than `VERIFIED_IMPROVED`). */
export const STATUS_FOR_RESULT: Readonly<Record<string, StatusKey>> = {
  VERIFIED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

/** Where a case sits on DETECT → … → MONITOR. */
export function flowStageFor(c: {
  readonly state: string;
  readonly accountability: { readonly acknowledgement: { readonly acknowledged: boolean } };
  readonly evidence: { readonly latestEvidencePackageId?: string };
}): FlowStage {
  switch (c.state) {
    case "OPEN":
      return c.accountability.acknowledgement.acknowledged ? "UNDERSTAND" : "DETECT";
    case "ACTION_REQUIRED":
      return "ACT";
    case "ACTION_REPORTED":
    case "VERIFYING":
      return "VERIFY";
    case "VERIFIED_IMPROVED":
      return c.evidence.latestEvidencePackageId === undefined ? "PROVE" : "MONITOR";
    case "PARTIALLY_VERIFIED":
    case "NOT_IMPROVING":
    case "INCONCLUSIVE":
      return "PROVE";
    case "REOPENED":
      return "DETECT";
    default:
      return "MONITOR";
  }
}

// ---- severity -----------------------------------------------------------------------------------

export const SEVERITY_MEANING: Readonly<Record<string, string>> = {
  LOW: "Low: monitor; no urgent action expected.",
  MODERATE: "Moderate: a person should review this soon.",
  HIGH: "High: the readings are far from normal; prompt attention is warranted.",
  CRITICAL: "Critical: far from normal with heat context; act without delay.",
};
export const SEVERITY_RANK: Readonly<Record<string, number>> = {
  CRITICAL: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
};

// ---- hazard and reason codes ---------------------------------------------------------------------

export const HAZARD_LABELS: Readonly<Record<string, string>> = {
  COOLING_ELECTRICAL_DETERIORATION: "Cooling / electrical deterioration",
};
export const hazardLabel = (code: string): string => HAZARD_LABELS[code] ?? humanizeCode(code);

/** The deterministic rule's reason codes, in plain words. */
const DETECTION_REASONS: Readonly<Record<string, string>> = {
  VIBRATION_Z_AT_OR_ABOVE_THRESHOLD: "Vibration is well above its learned baseline",
  CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD: "Electrical current is above its learned baseline",
  OUTDOOR_HEAT_CONTEXT: "Outdoor heat is above the configured limit",
  ZONE_TEMPERATURE_RISING: "The zone temperature is rising",
};
export function detectionReason(code: string): string {
  const persisted = /^PERSISTED_(\d+)_OF_(\d+)$/.exec(code);
  if (persisted) return `Persisted for ${persisted[1]} of ${persisted[2]} required checks`;
  return DETECTION_REASONS[code] ?? humanizeCode(code);
}

const VERIFICATION_REASONS: Readonly<Record<string, string>> = {
  ALL_REQUIRED_CRITERIA_PASSED: "Every required criterion passed",
  SUSTAINED_WITHIN_TARGET: "Stayed within target for the required period",
  SUSTAINED_IMPROVEMENT_TARGET_NOT_MET: "Improved, but not sustained within target",
  IMPROVED_BUT_NOT_AT_TARGET: "Improved but not at target",
  PARTIAL_IMPROVEMENT_NOT_AT_TARGET: "Partial improvement; target not reached",
  STILL_MATERIALLY_ABNORMAL: "Still materially abnormal",
  TRUSTED_EVIDENCE_SHOWS_NO_IMPROVEMENT: "Trusted evidence shows no improvement",
  DATA_COMPLETE_AND_FRESH: "Data was complete and fresh",
  DEVICES_HEALTHY_AND_AUTHENTICATED: "Devices were healthy and authenticated",
  ZONE_TEMPERATURE_STABLE_OR_FALLING: "Zone temperature stable or falling",
  ZONE_TEMPERATURE_INSUFFICIENT_SAMPLES: "Too few temperature samples to judge the trend",
  BACKUP_OBSERVED_RUNNING: "Backup capacity was observed running",
  BACKUP_NOT_OBSERVED_RUNNING: "Backup capacity was not observed running",
  INSUFFICIENT_OBSERVATIONS: "Too few trusted observations",
  INSUFFICIENT_OBSERVATIONS_IN_SUSTAINED_INTERVAL: "Too few observations in the sustained interval",
  GAP_IN_SUSTAINED_INTERVAL: "A gap in the data broke the sustained interval",
  NO_TRUSTED_OBSERVATIONS: "No trusted observations after the action",
  REQUIRED_SIGNAL_MISSING: "A required signal was missing",
  STALE_REQUIRED_TELEMETRY: "Required telemetry was stale",
  MISSINGNESS_EXCEEDS_LIMIT: "Too much data was missing",
  MISSING_INTERVAL_EXCEEDS_LIMIT: "A data gap exceeded the limit",
  LOW_TELEMETRY_CONFIDENCE: "Telemetry confidence was too low",
  LOW_CONFIDENCE: "Confidence was too low",
  DEVICE_NOT_HEALTHY: "A required device was not healthy",
  DEVICE_NOT_ACTIVE: "A required device was not active",
  DEVICE_NOT_REGISTERED: "A required device was not registered",
  DEVICE_NOT_BOUND_TO_ASSET: "A device was not bound to the asset",
  NO_REGISTERED_DEVICE_FOR_REQUIRED_ASSET: "No registered device for a required asset",
  UNAUTHENTICATED_EVIDENCE_PRESENT: "Unauthenticated readings were present",
  UNHEALTHY_OR_UNBOUND_DEVICE_DATA_EXCEEDS_LIMIT: "Too much data from unhealthy or unbound devices",
  EVIDENCE_INSUFFICIENT_TO_ESTABLISH_OUTCOME: "Evidence insufficient to establish the outcome",
  EVIDENCE_UNTRUSTED_OR_DEVICE_INTEGRITY_NOT_ESTABLISHED:
    "Evidence untrusted or device integrity not established",
};
export const verificationReason = (code: string): string =>
  VERIFICATION_REASONS[code] ?? humanizeCode(code);

const INTERVENTION_REASONS: Readonly<Record<string, string>> = {
  NO_ESCALATION_CONDITION_MET: "No escalation condition is met",
  IMPROVEMENT_CONFIRMED_UNDER_RECURRENCE_WATCH: "Improvement verified; recurrence is being watched",
  HIGH_SEVERITY_UNRESOLVED: "A high-severity risk is unresolved",
  CRITICAL_SEVERITY_UNRESOLVED: "A critical-severity risk is unresolved",
  ACKNOWLEDGEMENT_ESCALATED: "The alert was not acknowledged in time",
  LATEST_VERIFICATION_PARTIAL: "The latest verification was only partial",
  LATEST_VERIFICATION_NOT_IMPROVING: "The latest verification showed no improvement",
  LATEST_VERIFICATION_INCONCLUSIVE: "The latest verification was inconclusive",
  REPEATED_INCONCLUSIVE_VERIFICATION: "Verification was inconclusive more than once",
  TWO_CONSECUTIVE_UNSUCCESSFUL_VERIFICATIONS: "Two verifications in a row were unsuccessful",
  THREE_CONSECUTIVE_UNSUCCESSFUL_VERIFICATIONS: "Three verifications in a row were unsuccessful",
  RECURRED_AFTER_VERIFIED_IMPROVEMENT: "The hazard returned after a verified improvement",
  RECURRED_TWICE_AFTER_VERIFIED_IMPROVEMENT: "The hazard returned twice after verified improvement",
  CRITICAL_RISK_NOT_IMPROVING: "A critical risk is not improving",
  INSUFFICIENT_REMOTE_EVIDENCE: "Remote evidence is not sufficient to judge",
  CRITICAL_UNRESOLVED_WITH_INSUFFICIENT_REMOTE_EVIDENCE:
    "A critical risk is unresolved and remote evidence is insufficient",
  DEVICE_OR_AUTH_INTEGRITY_ISSUE: "A device or authenticity problem limits the evidence",
};
export const interventionReason = (code: string): string =>
  INTERVENTION_REASONS[code] ?? humanizeCode(code);

// ---- intervention levels -------------------------------------------------------------------------

export const INTERVENTION_ORDER: readonly InterventionLevel[] = [
  "REMOTE_MONITORING",
  "REMOTE_REVIEW",
  "RISK_ENGINEER_REVIEW",
  "SITE_VISIT_RECOMMENDED",
];

export const INTERVENTION_INFO: Readonly<
  Record<InterventionLevel, { readonly label: string; readonly meaning: string }>
> = {
  REMOTE_MONITORING: {
    label: "Remote Monitoring",
    meaning: "Keep watching the verified evidence. No review is recommended right now.",
  },
  REMOTE_REVIEW: {
    label: "Remote Review",
    meaning: "A person at the insurer may want to look at the evidence remotely.",
  },
  RISK_ENGINEER_REVIEW: {
    label: "Risk Engineer Review",
    meaning: "A risk engineer is recommended to review the evidence and the case history.",
  },
  SITE_VISIT_RECOMMENDED: {
    label: "Site Visit Recommended",
    meaning: "A site visit is recommended. Symbiosis does not schedule or dispatch anyone.",
  },
};

/** The statement that must travel with every recommendation. */
export const INTERVENTION_NOTE =
  "Decision support only. Symbiosis does not schedule, dispatch or instruct a risk engineer, and it changes no coverage, pricing or underwriting.";

// ---- criteria ------------------------------------------------------------------------------------

export const CRITERION_LABELS: Readonly<Record<string, string>> = {
  VIBRATION: "Vibration back within target",
  CURRENT: "Electrical current back within target",
  DATA_QUALITY: "Data completeness and freshness",
  DEVICE_INTEGRITY: "Device health and authenticity",
  ZONE_TEMPERATURE_SLOPE: "Zone temperature trend",
  BACKUP_CAPACITY: "Backup capacity",
};
export const criterionLabel = (id: string): string => CRITERION_LABELS[id] ?? humanizeCode(id);

export const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  PASS: "Passed",
  FAIL: "Failed",
  PARTIAL: "Partial",
  INCONCLUSIVE: "Inconclusive",
};
export const outcomeLabel = (o: string): string => OUTCOME_LABELS[o] ?? humanizeCode(o);

// ---- audit timeline ------------------------------------------------------------------------------

export type TimelineKind = "detect" | "alert" | "act" | "verify" | "evidence" | "consent" | "recur";

/** Milestones shown on the case timeline. Anything not listed here is internal bookkeeping. */
export const TIMELINE: Readonly<
  Record<string, { readonly label: string; readonly kind: TimelineKind }>
> = {
  CASE_CREATED: { label: "Risk detected; case opened", kind: "detect" },
  DETECTION_RECORDED: { label: "Risk pattern detected again", kind: "detect" },
  ALERT_SENT: { label: "Alert sent", kind: "alert" },
  ALERT_FAILED: { label: "Alert delivery failed", kind: "alert" },
  RISK_ACKNOWLEDGED: { label: "Risk acknowledged", kind: "act" },
  RISK_ESCALATED: { label: "Escalated: not acknowledged in time", kind: "alert" },
  ACTION_ASSIGNED: { label: "Approved action assigned", kind: "act" },
  ACTION_ACKNOWLEDGED: { label: "Assignment acknowledged", kind: "act" },
  ACTION_REPORTED: { label: "Action reported complete (not yet verified)", kind: "act" },
  VERIFICATION_STARTED: { label: "Verification started", kind: "verify" },
  VERIFICATION_COMPLETED: { label: "Verification completed", kind: "verify" },
  INTERVENTION_RECOMMENDED: { label: "Risk-engineer recommendation updated", kind: "verify" },
  RECURRENCE_DETECTED: { label: "Recurrence detected", kind: "recur" },
  CASE_REOPENED: { label: "Case reopened", kind: "recur" },
  EVIDENCE_PACKAGE_CREATED: { label: "Evidence package created", kind: "evidence" },
  SHARING_AGREEMENT_CREATED: { label: "Sharing granted to an insurer", kind: "consent" },
  SHARING_AGREEMENT_REVOKED: { label: "Sharing revoked", kind: "consent" },
  EVIDENCE_SHARED: { label: "Evidence shared under an agreement", kind: "consent" },
  INSURER_EVIDENCE_READ: { label: "Insurer read the shared evidence", kind: "consent" },
  INSURER_ACCESS_DENIED: { label: "An insurer access attempt was denied", kind: "consent" },
};

// ---- consent -------------------------------------------------------------------------------------

export type ScopeInfo = {
  readonly label: string;
  readonly plain: string;
  readonly group: "summary" | "verification" | "evidence";
};
export const SCOPE_INFO: Readonly<Record<ConsentScope, ScopeInfo>> = {
  RECOMMENDATION: {
    label: "Risk summary",
    plain: "The hazard, severity and current case state.",
    group: "summary",
  },
  EVENT_SUMMARY: {
    label: "What was detected",
    plain: "When the risk was detected and the rule's reason codes.",
    group: "summary",
  },
  ACTION_SUMMARY: {
    label: "Actions reported",
    plain: "Which approved actions were assigned and reported, and when. No names or notes.",
    group: "summary",
  },
  VERIFICATION_RESULT: {
    label: "Verification outcome",
    plain: "Whether the risk was verified improved, with the policy used.",
    group: "verification",
  },
  VERIFICATION_CONFIDENCE: {
    label: "Confidence and completeness",
    plain: "How complete and trustworthy the supporting data was.",
    group: "verification",
  },
  BEFORE_AFTER_METRICS: {
    label: "Before / after measurements",
    plain: "Summary statistics (mean, range) before and after the action. Not raw readings.",
    group: "verification",
  },
  RECURRENCE_STATUS: {
    label: "Recurrence status",
    plain: "Whether the hazard has come back.",
    group: "verification",
  },
  EVIDENCE_ARTIFACTS: {
    label: "Evidence package details",
    plain:
      "Package ID, hashes, and the list of records it contains. Raw readings are only counted.",
    group: "evidence",
  },
  INTERVENTION_RECOMMENDATION: {
    label: "Risk-engineer recommendation",
    plain: "The deterministic recommendation level and its reasons.",
    group: "evidence",
  },
  RAW_TELEMETRY: {
    label: "Raw telemetry",
    plain:
      "Individual sensor readings. Advanced: share only if you intend the insurer to see them.",
    group: "evidence",
  },
};

export const STANDARD_SCOPES: readonly ConsentScope[] = [
  "RECOMMENDATION",
  "EVENT_SUMMARY",
  "ACTION_SUMMARY",
  "BEFORE_AFTER_METRICS",
  "VERIFICATION_RESULT",
  "VERIFICATION_CONFIDENCE",
  "RECURRENCE_STATUS",
  "EVIDENCE_ARTIFACTS",
  "INTERVENTION_RECOMMENDATION",
];

export const AGREEMENT_STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: "Active",
  REVOKED: "Revoked",
  EXPIRED: "Expired",
  NOT_YET_EFFECTIVE: "Not yet effective",
};

export const DENIAL_REASONS: Readonly<Record<string, { title: string; text: string }>> = {
  AGREEMENT_REVOKED: {
    title: "Sharing was revoked",
    text: "The customer revoked the sharing agreement. Evidence is no longer available to you.",
  },
  AGREEMENT_EXPIRED: {
    title: "Sharing has expired",
    text: "The sharing agreement reached its end date. Ask the customer to renew it.",
  },
  AGREEMENT_NOT_YET_EFFECTIVE: {
    title: "Sharing has not started",
    text: "The sharing agreement is not yet in effect.",
  },
  SCOPE_NOT_GRANTED: {
    title: "Not covered by the agreement",
    text: "The customer has not shared this kind of evidence with you.",
  },
  NO_AGREEMENT_FOR_TARGET: {
    title: "Not shared with you",
    text: "No active sharing agreement covers this case. It may not exist, or it has not been shared.",
  },
};
