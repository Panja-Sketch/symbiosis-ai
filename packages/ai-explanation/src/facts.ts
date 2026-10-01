import {
  SCOPE_LABELS,
  criterionLabel,
  detectionReason,
  formatNumber,
  formatPercent,
  hazardLabel,
  interventionLabel,
  interventionReason,
  outcomeLabel,
  RESULT_LABELS,
  sharingLabel,
  stateLabel,
  verificationReason,
} from "./phrases";
import type { ExplanationContext, Fact, SourceRef, UntrustedText } from "./types";

/**
 * Context builders: the ONLY place facts are made. They read the application's existing read
 * models (the facility `CaseView`, the insurer's scope-filtered projection) and nothing else: there
 * is no input for telemetry streams, device keys, credentials or other tenants, so none can reach a
 * prompt. A field the audience is not allowed to see is simply absent, and its absence is recorded
 * as "unavailable" instead of being filled in.
 */

type Stat = {
  readonly sampleCount?: number;
  readonly mean?: number;
  readonly min?: number;
  readonly max?: number;
};

// ---- facility (structural subset of the application API's CaseView) -------------------------------

export type FacilityCaseInput = {
  readonly caseId: string;
  readonly title: string;
  readonly hazardType: string;
  readonly severity: string;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly state: string;
  readonly riskEventId?: string;
  readonly riskEventState?: string;
  readonly reasonCodes: readonly string[];
  readonly detectionCount: number;
  readonly latestDetectionAt?: string;
  readonly accountability: {
    readonly acknowledgement: { readonly acknowledged: boolean; readonly at?: string };
    readonly escalation: { readonly escalated: boolean };
  };
  readonly whatToDo: {
    readonly approvedActions: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
    }[];
  };
  readonly whatWasDone: {
    readonly actions: readonly {
      readonly actionId: string;
      readonly actionLibraryId: string;
      readonly title: string;
      readonly status: string;
      readonly reportedAt?: string;
      readonly notes?: string;
    }[];
  };
  readonly didItWork: { readonly status: string; readonly label: string };
  readonly verification?: {
    readonly verificationId: string;
    readonly status: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly evaluatedAt?: string;
    readonly result?: string;
    readonly confidence?: number;
    readonly dataCompleteness?: number;
    readonly telemetryConfidence?: number;
    readonly deviceHealthStatus?: string;
    readonly authIntegrityStatus?: string;
    readonly reasonCodes: readonly string[];
    readonly criteria: readonly {
      readonly criterionId: string;
      readonly role: string;
      readonly outcome: string;
      readonly before?: Stat;
      readonly observed?: Stat;
      readonly reasonCodes: readonly string[];
    }[];
  };
  readonly stayingFixed: {
    readonly watch: string;
    readonly watchEndsAt?: string;
    readonly recurrenceCount: number;
    readonly lastRecurrence?: { readonly at: string };
  };
  readonly intervention?: {
    readonly interventionId: string;
    readonly level: string;
    readonly status: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly reasonCodes: readonly string[];
    readonly dataSufficiency: number;
  };
  readonly evidence: { readonly latestEvidencePackageId?: string };
  readonly sharing: { readonly state: string };
};

/** What the evidence service reported about the latest package (the role may not read it: absent). */
export type EvidenceInput = {
  readonly packageId: string;
  readonly createdAt: string;
  readonly integrity: "PASSED" | "FAILED" | "NOT_CHECKED";
  readonly synthetic: boolean;
  readonly sourceLabel: string;
  readonly artifactCount?: number;
};

const times = (n: number): string => (n === 1 ? "once" : `${n} times`);
const recurrences = (n: number): string =>
  n === 0 ? "no recurrences" : n === 1 ? "1 recurrence" : `${n} recurrences`;

const NOTE_MAX = 500;
/** Untrusted text is length-limited and stripped of control characters before it is ever delimited into a prompt. */
const cleanUntrusted = (s: string): string =>
  [...s]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      const control = (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
      return control ? " " : ch;
    })
    .join("")
    .trim()
    .slice(0, NOTE_MAX);

export function buildFacilityContext(
  input: FacilityCaseInput,
  evidence?: EvidenceInput,
): ExplanationContext {
  const c = input;
  const facts: Fact[] = [];
  const sources: SourceRef[] = [{ type: "CASE", id: c.caseId }];
  const unavailable: string[] = [];
  const untrusted: UntrustedText[] = [];
  const add = (id: string, label: string, value: string) => facts.push({ id, label, value });

  add(
    "F-CASE",
    "Case",
    `${c.severity.toLowerCase()} severity ${hazardLabel(c.hazardType)} case ${c.caseId} at facility ${c.facilityId} involving ${c.assetIds.join(", ")}`,
  );
  add("F-STATE", "Case state", `the case state is ${stateLabel(c.state)}`);
  if (c.riskEventId !== undefined) {
    sources.push({ type: "RISK_EVENT", id: c.riskEventId });
  }
  add(
    "F-DETECTION",
    "What was detected",
    c.reasonCodes.length === 0
      ? `a risk pattern was detected ${times(c.detectionCount)}`
      : `a risk pattern was detected ${times(c.detectionCount)} because ${c.reasonCodes.map(detectionReason).join("; ")}${c.latestDetectionAt !== undefined ? `; latest detection ${c.latestDetectionAt}` : ""}`,
  );
  add(
    "F-ACCOUNTABILITY",
    "Acknowledgement",
    `${c.accountability.acknowledgement.acknowledged ? `the risk was acknowledged${c.accountability.acknowledgement.at !== undefined ? ` at ${c.accountability.acknowledgement.at}` : ""}` : "the risk has not been acknowledged"}; ${c.accountability.escalation.escalated ? "the alert was escalated" : "the alert was not escalated"}`,
  );

  // actions: titles come from the approved library; notes are untrusted free text
  c.whatWasDone.actions.forEach((a, i) => {
    const n = i + 1;
    sources.push({ type: "ACTION", id: a.actionId });
    add(
      `F-ACTION-${n}`,
      "Action",
      `the approved action "${a.title}" (${a.actionLibraryId}) is ${a.status === "REPORTED_COMPLETE" ? `reported complete by a person${a.reportedAt !== undefined ? ` at ${a.reportedAt}` : ""}; a report is not proof of improvement` : a.status.toLowerCase()}`,
    );
    if (a.notes !== undefined && a.notes.trim() !== "") {
      untrusted.push({
        id: `N-${n}`,
        origin: `note on action ${a.actionLibraryId}`,
        text: cleanUntrusted(a.notes),
      });
    }
  });
  if (c.whatWasDone.actions.length === 0)
    unavailable.push("no action has been assigned or reported yet");

  const v = c.verification;
  if (v !== undefined && v.status === "COMPLETED" && v.result !== undefined) {
    sources.push({
      type: "VERIFICATION",
      id: v.verificationId,
      version: `${v.policyId} v${v.policyVersion}`,
    });
    add(
      "F-VERIFICATION",
      "Verification result (deterministic engine)",
      `${RESULT_LABELS[v.result] ?? v.result}${v.evaluatedAt !== undefined ? `, evaluated ${v.evaluatedAt}` : ""}; reasons: ${v.reasonCodes.map(verificationReason).join("; ") || "none recorded"}`,
    );
    add("F-POLICY", "Verification policy", `${v.policyId} version ${v.policyVersion}`);
    add(
      "F-QUALITY",
      "Data quality",
      `confidence ${formatPercent(v.confidence)}, data completeness ${formatPercent(v.dataCompleteness)}, telemetry confidence ${formatPercent(v.telemetryConfidence)}, device health ${(v.deviceHealthStatus ?? "unavailable").toLowerCase()}, authenticity ${(v.authIntegrityStatus ?? "unavailable").toLowerCase()}`,
    );
    for (const k of v.criteria) {
      const m =
        k.before?.mean !== undefined && k.observed?.mean !== undefined
          ? `; mean ${formatNumber(k.before.mean)} before the action and ${formatNumber(k.observed.mean)} after`
          : "";
      add(
        `F-CRITERION-${k.criterionId}`,
        `Criterion: ${criterionLabel(k.criterionId)}`,
        `${criterionLabel(k.criterionId)} (${k.role.toLowerCase()}) ${outcomeLabel(k.outcome)}${m}${k.reasonCodes.length > 0 ? `; ${k.reasonCodes.map(verificationReason).join("; ")}` : ""}`,
      );
    }
  } else if (c.didItWork.status === "VERIFICATION_PENDING") {
    unavailable.push("verification is still pending, so there is no verification result yet");
  } else {
    unavailable.push("no completed verification exists for the current cycle");
  }

  add(
    "F-RECURRENCE",
    "Recurrence",
    `${recurrences(c.stayingFixed.recurrenceCount)}; recurrence watch is ${c.stayingFixed.watch.toLowerCase().replace(/_/g, " ")}${c.stayingFixed.watchEndsAt !== undefined ? ` until ${c.stayingFixed.watchEndsAt}` : ""}${c.stayingFixed.lastRecurrence !== undefined ? `; last recurrence ${c.stayingFixed.lastRecurrence.at}` : ""}`,
  );

  if (c.intervention !== undefined) {
    const i = c.intervention;
    sources.push({
      type: "INTERVENTION",
      id: i.interventionId,
      version: `${i.policyId} v${i.policyVersion}`,
    });
    add(
      "F-INTERVENTION",
      "Risk-engineer recommendation (deterministic policy)",
      `${interventionLabel(i.level)} (${i.status.toLowerCase()}); reasons: ${i.reasonCodes.map(interventionReason).join("; ")}; evidence sufficiency ${formatPercent(i.dataSufficiency)}; policy ${i.policyId} version ${i.policyVersion}`,
    );
  } else {
    unavailable.push("no risk-engineer recommendation exists");
  }

  if (evidence !== undefined) {
    sources.push({ type: "EVIDENCE_PACKAGE", id: evidence.packageId });
    add(
      "F-EVIDENCE",
      "Evidence package",
      `package ${evidence.packageId} created ${evidence.createdAt}; integrity check ${evidence.integrity === "PASSED" ? "passed (SHA-256 recomputed)" : evidence.integrity === "FAILED" ? "FAILED" : "not performed"}; data origin: ${evidence.synthetic ? "synthetic demonstration data" : "not marked synthetic"} (${evidence.sourceLabel})${evidence.artifactCount !== undefined ? `; ${evidence.artifactCount} records` : ""}`,
    );
  } else if (c.evidence.latestEvidencePackageId === undefined) {
    unavailable.push("no evidence package exists yet");
  } else {
    unavailable.push("evidence package details are not available to this role");
  }
  add("F-SHARING", "Sharing", sharingLabel(c.sharing.state));

  return {
    audience: "FACILITY",
    caseId: c.caseId,
    facts,
    sources,
    authoritative: {
      caseState: c.state,
      ...(v?.status === "COMPLETED" && v.result !== undefined && { verificationResult: v.result }),
      ...(c.intervention !== undefined && { interventionLevel: c.intervention.level }),
      recurrenceCount: c.stayingFixed.recurrenceCount,
      sharingState: c.sharing.state,
    },
    allowedActions: c.whatToDo.approvedActions.map((a) => ({
      id: a.actionLibraryId,
      title: a.title,
    })),
    unavailable,
    untrusted,
  };
}

// ---- insurer (structural subset of the scope-filtered insurer projection) -------------------------

export type InsurerCaseInput = {
  readonly caseId: string;
  readonly siteId: string;
  readonly consent: { readonly grantedScopes: readonly string[] };
  readonly sharingState: string;
  readonly source?: { readonly synthetic: boolean; readonly label: string };
  readonly evidenceAvailable?: boolean;
  readonly recommendation?: {
    readonly hazardType: string;
    readonly severity: string;
    readonly caseState: string;
    readonly approvedActions?: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
    }[];
  };
  readonly eventSummary?: {
    readonly eventId: string;
    readonly detectedAt: string;
    readonly detectionReasonCodes: readonly string[];
  };
  readonly actionSummary?: {
    readonly actions: readonly {
      readonly actionLibraryId: string;
      readonly title?: string;
      readonly status: string;
      readonly reportedAt?: string;
    }[];
  };
  readonly verification?: {
    readonly result: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly evaluatedAt: string;
    readonly reasonCodes: readonly string[];
    readonly criteria: readonly {
      readonly criterionId: string;
      readonly role: string;
      readonly outcome: string;
    }[];
  };
  readonly confidence?: {
    readonly confidence: number;
    readonly dataCompleteness: number;
    readonly telemetryConfidence: number;
    readonly deviceHealthStatus: string;
    readonly authIntegrityStatus: string;
  };
  readonly beforeAfter?: readonly {
    readonly criterionId: string;
    readonly before?: Stat;
    readonly after?: Stat;
  }[];
  readonly recurrence?: {
    readonly recurrenceCountAtPackage: number;
    readonly currentRecurrenceCount: number;
    readonly reopenedSincePackage: boolean;
  };
  readonly evidencePackage?: {
    readonly packageId: string;
    readonly createdAt: string;
    readonly integrity: "VERIFIED";
    readonly artifacts: readonly unknown[];
    readonly observationArtifactCount: number;
  };
};

export type InsurerInterventionInput = {
  readonly interventionId: string;
  readonly level: string;
  readonly status: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
};

export function buildInsurerContext(
  v: InsurerCaseInput,
  intervention?: InsurerInterventionInput,
): ExplanationContext {
  const facts: Fact[] = [];
  const sources: SourceRef[] = [{ type: "CASE", id: v.caseId }];
  const unavailable: string[] = [];
  const add = (id: string, label: string, value: string) => facts.push({ id, label, value });
  const granted = (s: string) => v.consent.grantedScopes.includes(s);
  const note = (scope: string) =>
    unavailable.push(
      `${SCOPE_LABELS[scope] ?? scope} (not shared with the insurer, so it cannot be explained)`,
    );

  add(
    "F-CASE",
    "Case",
    `shared case ${v.caseId} at site ${v.siteId}; sharing state: ${sharingLabel(v.sharingState)}`,
  );

  if (v.recommendation !== undefined) {
    add(
      "F-RISK",
      "Risk summary",
      `${v.recommendation.severity.toLowerCase()} severity ${hazardLabel(v.recommendation.hazardType)} case`,
    );
    add("F-STATE", "Case state", `the case state is ${stateLabel(v.recommendation.caseState)}`);
  } else if (!granted("RECOMMENDATION")) note("RECOMMENDATION");

  if (v.eventSummary !== undefined) {
    sources.push({ type: "RISK_EVENT", id: v.eventSummary.eventId });
    add(
      "F-DETECTION",
      "What was detected",
      `detected ${v.eventSummary.detectedAt} because ${v.eventSummary.detectionReasonCodes.map(detectionReason).join("; ")}`,
    );
  } else if (!granted("EVENT_SUMMARY")) note("EVENT_SUMMARY");

  if (v.actionSummary !== undefined) {
    v.actionSummary.actions.forEach((a, i) => {
      add(
        `F-ACTION-${i + 1}`,
        "Customer-reported action",
        `the approved action "${a.title ?? a.actionLibraryId}" was ${a.status === "REPORTED_COMPLETE" ? `reported complete by the customer${a.reportedAt !== undefined ? ` at ${a.reportedAt}` : ""}; a customer report is not proof of improvement` : a.status.toLowerCase()}`,
      );
    });
    if (v.actionSummary.actions.length === 0) unavailable.push("no action has been reported");
  } else if (!granted("ACTION_SUMMARY")) note("ACTION_SUMMARY");

  let result: string | undefined;
  if (v.verification !== undefined) {
    result = v.verification.result;
    add(
      "F-VERIFICATION",
      "Verification result (deterministic engine)",
      `${RESULT_LABELS[result] ?? result}, evaluated ${v.verification.evaluatedAt}; reasons: ${v.verification.reasonCodes.map(verificationReason).join("; ") || "none recorded"}`,
    );
    add(
      "F-POLICY",
      "Verification policy",
      `${v.verification.policyId} version ${v.verification.policyVersion}`,
    );
    for (const k of v.verification.criteria) {
      const ba = v.beforeAfter?.find((b) => b.criterionId === k.criterionId);
      const m =
        ba?.before?.mean !== undefined && ba.after?.mean !== undefined
          ? `; mean ${formatNumber(ba.before.mean)} before the action and ${formatNumber(ba.after.mean)} after`
          : "";
      add(
        `F-CRITERION-${k.criterionId}`,
        `Criterion: ${criterionLabel(k.criterionId)}`,
        `${criterionLabel(k.criterionId)} (${k.role.toLowerCase()}) ${outcomeLabel(k.outcome)}${m}`,
      );
    }
  } else if (!granted("VERIFICATION_RESULT")) note("VERIFICATION_RESULT");
  if (
    v.verification !== undefined &&
    v.beforeAfter === undefined &&
    !granted("BEFORE_AFTER_METRICS")
  ) {
    note("BEFORE_AFTER_METRICS");
  }

  if (v.confidence !== undefined) {
    add(
      "F-QUALITY",
      "Data quality",
      `confidence ${formatPercent(v.confidence.confidence)}, data completeness ${formatPercent(v.confidence.dataCompleteness)}, telemetry confidence ${formatPercent(v.confidence.telemetryConfidence)}, device health ${v.confidence.deviceHealthStatus.toLowerCase()}, authenticity ${v.confidence.authIntegrityStatus.toLowerCase()}`,
    );
  } else if (!granted("VERIFICATION_CONFIDENCE")) note("VERIFICATION_CONFIDENCE");

  if (v.recurrence !== undefined) {
    add(
      "F-RECURRENCE",
      "Recurrence",
      `${recurrences(v.recurrence.currentRecurrenceCount)} now (${recurrences(v.recurrence.recurrenceCountAtPackage)} when the evidence package was made); ${v.recurrence.reopenedSincePackage ? "the case was reopened since the package" : "not reopened since the package"}`,
    );
  } else if (!granted("RECURRENCE_STATUS")) note("RECURRENCE_STATUS");

  if (intervention !== undefined) {
    sources.push({
      type: "INTERVENTION",
      id: intervention.interventionId,
      version: `${intervention.policyId} v${intervention.policyVersion}`,
    });
    add(
      "F-INTERVENTION",
      "Risk-engineer recommendation (deterministic policy)",
      `${interventionLabel(intervention.level)} (${intervention.status.toLowerCase()}); reasons: ${intervention.reasonCodes.map(interventionReason).join("; ")}; evidence sufficiency ${formatPercent(intervention.dataSufficiency)}; policy ${intervention.policyId} version ${intervention.policyVersion}`,
    );
  } else if (!granted("INTERVENTION_RECOMMENDATION")) note("INTERVENTION_RECOMMENDATION");

  if (v.evidencePackage !== undefined) {
    sources.push({ type: "EVIDENCE_PACKAGE", id: v.evidencePackage.packageId });
    add(
      "F-EVIDENCE",
      "Evidence package",
      `package ${v.evidencePackage.packageId} created ${v.evidencePackage.createdAt}; integrity verified (SHA-256) before release; data origin: ${v.source?.synthetic === false ? "not marked synthetic" : "synthetic demonstration data"}${v.source !== undefined ? ` (${v.source.label})` : ""}; ${v.evidencePackage.artifacts.length + v.evidencePackage.observationArtifactCount} records`,
    );
  } else if (v.evidenceAvailable === false) {
    unavailable.push("no evidence package exists for this case yet");
  } else if (!granted("EVIDENCE_ARTIFACTS")) note("EVIDENCE_ARTIFACTS");

  const approved = v.recommendation?.approvedActions ?? [];
  return {
    audience: "INSURER",
    caseId: v.caseId,
    facts,
    sources,
    authoritative: {
      ...(v.recommendation !== undefined && { caseState: v.recommendation.caseState }),
      ...(result !== undefined && { verificationResult: result }),
      ...(intervention !== undefined && { interventionLevel: intervention.level }),
      ...(v.recurrence !== undefined && { recurrenceCount: v.recurrence.currentRecurrenceCount }),
      sharingState: v.sharingState,
    },
    allowedActions: approved.map((a) => ({ id: a.actionLibraryId, title: a.title })),
    unavailable,
    untrusted: [],
  };
}
