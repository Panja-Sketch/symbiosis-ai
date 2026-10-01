import type {
  Alert,
  AlertStatus,
  AuditEntry,
  CaseSeverity,
  CaseState,
  MitigationAction,
  CriterionResult,
  CriterionStat,
  InterventionLevel,
  RiskEngineerInterventionRecommendation,
  RiskEvent,
  RiskEventState,
  RiskImprovementCase,
  VerificationAttempt,
} from "@symbiosis/contracts";
import { describeReasonCodes } from "@symbiosis/notifications";
import { RESULT_DETAILS, RESULT_LABELS, VERIFICATION_PENDING_LABEL } from "@symbiosis/verification";
import { actionsFor } from "./library";
import type { ActionLibrary } from "./library";

export type CaseViewSummary = {
  readonly caseId: string;
  readonly title: string;
  readonly severity: CaseSeverity;
  readonly state: CaseState;
  readonly riskEventState?: RiskEventState;
  readonly facilityId: string;
  readonly didItWork: string;
  readonly createdAt: string;
};

export { VERIFICATION_PENDING_LABEL };

/** Human-readable labels of the four intervention levels (spec 23A.1). */
export const INTERVENTION_LABELS: Readonly<Record<InterventionLevel, string>> = {
  REMOTE_MONITORING: "Remote Monitoring",
  REMOTE_REVIEW: "Remote Review",
  RISK_ENGINEER_REVIEW: "Risk Engineer Review",
  SITE_VISIT_RECOMMENDED: "Site Visit Recommended",
};

export type CriterionView = {
  readonly criterionId: string;
  readonly role: string;
  readonly outcome: string;
  readonly assetId?: string;
  readonly signal?: string;
  readonly metric?: string;
  readonly referenceMean?: number;
  readonly referenceModes: readonly string[];
  readonly before?: CriterionStat;
  readonly observed?: CriterionStat;
  readonly observedMetric?: CriterionStat;
  readonly reasonCodes: readonly string[];
  readonly evidenceCount: number;
};

export type VerificationView = {
  readonly verificationId: string;
  readonly status: VerificationAttempt["status"];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly postActionWindow: { readonly start: string; readonly end: string };
  readonly startedAt: string;
  readonly evaluatedAt?: string;
  readonly result?: string;
  readonly resultLabel?: string;
  readonly confidence?: number;
  readonly dataCompleteness?: number;
  readonly telemetryConfidence?: number;
  readonly deviceHealthStatus?: string;
  readonly authIntegrityStatus?: string;
  readonly reasonCodes: readonly string[];
  readonly criteria: readonly CriterionView[];
  readonly evidenceReferenceCount: number;
};

export type InterventionView = {
  readonly interventionId: string;
  readonly level: InterventionLevel;
  readonly label: string;
  readonly status: RiskEngineerInterventionRecommendation["status"];
  readonly policyId: string;
  readonly policyVersion: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
  readonly generatedAt: string;
};

/**
 * Operations read model for the case detail screen (spec section 25), shaped for the minimal
 * S4 workflow-proof page and the API. `didItWork` is a derived PRESENTATION label: there is no
 * "verification pending" lifecycle state. No wording here ever claims physical improvement.
 */
export type CaseView = {
  readonly caseId: string;
  readonly title: string;
  readonly hazardType: string;
  readonly severity: CaseSeverity;
  readonly facilityId: string;
  readonly assetIds: readonly string[];
  readonly state: CaseState;
  readonly riskEventId?: string;
  readonly riskEventState?: RiskEventState;
  readonly reasonCodes: readonly string[];
  readonly detectionCount: number;
  readonly latestDetectionAt?: string;
  readonly whatHappened: { readonly summary: string; readonly reasons: readonly string[] };
  readonly accountability: {
    readonly ownerId?: string;
    readonly alert: {
      readonly status: "NOT_REQUESTED" | AlertStatus;
      readonly recipient?: string;
      readonly sentAt?: string;
      readonly attempts: number;
      readonly deliveryFailed: boolean;
      readonly exhausted: boolean;
    };
    readonly acknowledgement: {
      readonly acknowledged: boolean;
      readonly by?: string;
      readonly at?: string;
    };
    readonly escalation: {
      readonly escalated: boolean;
      readonly at?: string;
      readonly reason?: string;
    };
  };
  readonly whatToDo: {
    readonly mode: "RECOMMEND_ONLY";
    readonly approvedActions: readonly {
      readonly actionLibraryId: string;
      readonly title: string;
      readonly description: string;
      readonly status: "AVAILABLE" | "ASSIGNED" | "REPORTED";
    }[];
  };
  readonly whatWasDone: {
    readonly actions: readonly {
      readonly actionId: string;
      readonly actionLibraryId: string;
      readonly title: string;
      readonly status: MitigationAction["status"];
      readonly assignedTo?: string;
      readonly reportedBy?: string;
      readonly reportedAt?: string;
      readonly notes?: string;
      readonly attachments: readonly string[];
    }[];
  };
  readonly didItWork: {
    readonly status:
      | "NOT_APPLICABLE_YET"
      | "VERIFICATION_PENDING"
      | "VERIFIED_IMPROVED"
      | "PARTIALLY_VERIFIED"
      | "NOT_IMPROVING"
      | "INCONCLUSIVE"
      | "NOT_AVAILABLE";
    readonly label: string;
    readonly detail: string;
  };
  /** The attempt that decides the label above (latest completed, or the open one). */
  readonly verification?: VerificationView;
  readonly verificationHistory: readonly {
    readonly verificationId: string;
    readonly status: string;
    readonly result?: string;
    readonly evaluatedAt?: string;
  }[];
  /** "Is it staying fixed?": recurrence-watch status after an improvement. */
  readonly stayingFixed: {
    readonly watch: "NOT_ACTIVE" | "WATCHING" | "WATCH_ENDED";
    readonly watchEndsAt?: string;
    readonly recurrenceCount: number;
    readonly lastRecurrence?: { readonly at: string; readonly riskEventId: string };
  };
  readonly intervention?: InterventionView;
  readonly evidence: {
    readonly auditReferences: readonly {
      readonly auditId: string;
      readonly action: string;
      readonly at: string;
    }[];
  };
  readonly sharing: { readonly label: string };
};

const latest = (entries: readonly AuditEntry[], action: AuditEntry["action"]) =>
  [...entries].filter((e) => e.action === action).sort((a, b) => b.sequence - a.sequence)[0];

const criterionView = (c: CriterionResult): CriterionView => ({
  criterionId: c.criterionId,
  role: c.role ?? "REQUIRED",
  outcome: c.outcome ?? (c.passed ? "PASS" : "FAIL"),
  ...(c.assetId !== undefined && { assetId: c.assetId }),
  ...(c.signal !== undefined && { signal: c.signal }),
  ...(c.metric !== undefined && { metric: c.metric }),
  ...(c.reference?.mean !== undefined && { referenceMean: c.reference.mean }),
  referenceModes: c.reference?.operatingModes ?? [],
  ...(c.before !== undefined && { before: c.before }),
  ...(c.observed !== undefined && { observed: c.observed }),
  ...(c.observedMetric !== undefined && { observedMetric: c.observedMetric }),
  reasonCodes: c.reasonCodes ?? [],
  evidenceCount: c.evidenceIds?.length ?? 0,
});

function verificationView(a: VerificationAttempt): VerificationView {
  const x = a.assessment;
  return {
    verificationId: a.verificationId,
    status: a.status,
    policyId: a.policyId,
    policyVersion: a.policyVersion,
    postActionWindow: a.postActionWindow,
    startedAt: a.startedAt,
    ...(a.evaluatedAt !== undefined && { evaluatedAt: a.evaluatedAt }),
    ...(x !== undefined && {
      result: x.result,
      resultLabel: RESULT_LABELS[x.result],
      confidence: x.confidence,
      dataCompleteness: x.dataCompleteness,
      telemetryConfidence: x.telemetryConfidence,
      deviceHealthStatus: x.deviceHealthStatus,
      authIntegrityStatus: x.authIntegrityStatus,
    }),
    reasonCodes: x?.reasonCodes ?? [],
    criteria:
      x === undefined ? [] : [...x.requiredCriteria, ...x.supportingCriteria].map(criterionView),
    evidenceReferenceCount: a.evidenceReferences?.length ?? x?.evidenceIds.length ?? 0,
  };
}

const RESULT_STATE: Readonly<Record<string, CaseState>> = {
  VERIFIED: "VERIFIED_IMPROVED",
  PARTIALLY_VERIFIED: "PARTIALLY_VERIFIED",
  NOT_IMPROVING: "NOT_IMPROVING",
  INCONCLUSIVE: "INCONCLUSIVE",
};

/**
 * "Did it work?" is derived ONLY from persisted verification records. A case state alone never
 * produces a result label: a result label appears only when a completed assessment whose result
 * agrees with the case state exists. An action report yields VERIFICATION PENDING, never a result.
 */
function didItWork(
  c: RiskImprovementCase,
  attempts: readonly VerificationAttempt[],
): { readonly view: CaseView["didItWork"]; readonly attempt?: VerificationAttempt } {
  const state = c.state;
  const open = attempts.find((a) => a.status === "IN_PROGRESS");
  if (state === "ACTION_REPORTED") {
    return {
      view: {
        status: "VERIFICATION_PENDING",
        label: VERIFICATION_PENDING_LABEL,
        detail:
          "An action was reported. A report is not evidence that the risk improved: only new, trusted sensor readings after the action can show that.",
      },
      ...(open !== undefined && { attempt: open }),
    };
  }
  if (state === "VERIFYING") {
    return {
      view: {
        status: "VERIFICATION_PENDING",
        label: VERIFICATION_PENDING_LABEL,
        detail:
          open !== undefined
            ? `Collecting trusted post-action readings until ${open.postActionWindow.end}.`
            : "Verification has started; no result yet.",
      },
      ...(open !== undefined && { attempt: open }),
    };
  }
  if (
    state === "VERIFIED_IMPROVED" ||
    state === "PARTIALLY_VERIFIED" ||
    state === "NOT_IMPROVING" ||
    state === "INCONCLUSIVE"
  ) {
    const attempt = attempts.find(
      (a) => a.verificationId === c.latestVerificationId && a.status === "COMPLETED",
    );
    const result = attempt?.assessment?.result;
    if (attempt !== undefined && result !== undefined && RESULT_STATE[result] === state) {
      return {
        view: {
          status: result === "VERIFIED" ? "VERIFIED_IMPROVED" : result,
          label: RESULT_LABELS[result],
          detail: RESULT_DETAILS[result],
        },
        attempt,
      };
    }
    return {
      view: {
        status: "NOT_AVAILABLE",
        label: "RESULT NOT AVAILABLE",
        detail: "No completed verification record supports this state.",
      },
    };
  }
  if (state === "OPEN" || state === "ACTION_REQUIRED" || state === "REOPENED") {
    const last = [...attempts].reverse().find((a) => a.status === "COMPLETED");
    return {
      view: {
        status: "NOT_APPLICABLE_YET",
        label: "NO ACTION REPORTED YET",
        detail:
          last?.assessment !== undefined
            ? `No action reported in this cycle yet. Previous result: ${RESULT_LABELS[last.assessment.result]}.`
            : "Nothing to check yet: no action has been reported for this case.",
      },
    };
  }
  return {
    view: {
      status: "NOT_AVAILABLE",
      label: "RESULT NOT AVAILABLE",
      detail: "The case is closed.",
    },
  };
}

export function buildCaseView(input: {
  readonly caseRecord: RiskImprovementCase;
  readonly event?: RiskEvent;
  readonly actions: readonly MitigationAction[];
  readonly alerts: readonly Alert[];
  readonly audit: readonly AuditEntry[];
  readonly library: ActionLibrary;
  /** Oldest first. */
  readonly verifications?: readonly VerificationAttempt[];
  readonly interventions?: readonly RiskEngineerInterventionRecommendation[];
}): CaseView {
  const { caseRecord: c, event, actions, alerts, audit, library } = input;
  const attempts = input.verifications ?? [];
  const worked = didItWork(c, attempts);
  const recurrences = audit.filter((e) => e.action === "RECURRENCE_DETECTED");
  const lastRecurrence = [...recurrences].sort((a, b) => b.sequence - a.sequence)[0];
  const decided = attempts.find((a) => a.verificationId === c.latestVerificationId);
  const watchEnds = decided?.recurrenceWatchEndsAt;
  const currentIntervention = [...(input.interventions ?? [])]
    .reverse()
    .find((r) => r.status === "ACTIVE" || r.status === "ACKNOWLEDGED");
  const detections = audit.filter(
    (e) => e.action === "CASE_CREATED" || e.action === "DETECTION_RECORDED",
  );
  const lastDetection = [...detections].sort((a, b) => b.sequence - a.sequence)[0];
  const reasonCodes = (lastDetection?.details?.reasonCodes as readonly string[] | undefined) ?? [];
  const reasons = describeReasonCodes(reasonCodes);
  const primary = c.assetIds[0] ?? "unknown asset";

  const initial = alerts.find((a) => a.kind === "INITIAL");
  const ack = latest(audit, "RISK_ACKNOWLEDGED");
  const esc = latest(audit, "RISK_ESCALATED");
  const titleOf = (id: string) =>
    library.actions.find((a) => a.actionLibraryId === id)?.title ?? id;
  const statusFor = (id: string): "AVAILABLE" | "ASSIGNED" | "REPORTED" => {
    const mine = actions.filter((a) => a.actionLibraryId === id);
    if (mine.some((a) => a.status === "REPORTED_COMPLETE")) return "REPORTED";
    return mine.length > 0 ? "ASSIGNED" : "AVAILABLE";
  };
  const ownerId = c.assignedOwnerId;

  return {
    caseId: c.caseId,
    title: c.title,
    hazardType: c.hazardType,
    severity: c.severity,
    facilityId: c.facilityId,
    assetIds: c.assetIds,
    state: c.state,
    ...(event !== undefined && { riskEventId: event.eventId, riskEventState: event.state }),
    reasonCodes,
    detectionCount: detections.length,
    ...(lastDetection !== undefined && { latestDetectionAt: lastDetection.at }),
    whatHappened: {
      summary:
        `${c.severity} ${c.hazardType} on ${primary}` +
        (reasons.length > 0 ? `: ${reasons.join("; ")}` : ""),
      reasons,
    },
    accountability: {
      ...(ownerId !== undefined && { ownerId }),
      alert: {
        status: initial?.status ?? "NOT_REQUESTED",
        ...(initial !== undefined && { recipient: initial.recipient.ref }),
        ...(initial?.sentAt !== undefined && { sentAt: initial.sentAt }),
        attempts: initial?.attempts.length ?? 0,
        deliveryFailed: initial?.status === "FAILED",
        exhausted: initial?.exhausted ?? false,
      },
      acknowledgement: {
        acknowledged: ack !== undefined,
        ...(ack !== undefined && { by: ack.actorId, at: ack.at }),
      },
      escalation: {
        escalated: esc !== undefined,
        ...(esc !== undefined && { at: esc.at, reason: String(esc.details?.reason ?? "") }),
      },
    },
    whatToDo: {
      mode: "RECOMMEND_ONLY",
      approvedActions: actionsFor(library, c.hazardType).map((a) => ({
        actionLibraryId: a.actionLibraryId,
        title: a.title,
        description: a.description,
        status: statusFor(a.actionLibraryId),
      })),
    },
    whatWasDone: {
      actions: actions
        .filter((a) => a.status !== "ASSIGNED" || a.assignedTo !== undefined)
        .map((a) => ({
          actionId: a.actionId,
          actionLibraryId: a.actionLibraryId,
          title: titleOf(a.actionLibraryId),
          status: a.status,
          ...(a.assignedTo !== undefined && { assignedTo: a.assignedTo }),
          ...(a.reportedBy !== undefined && { reportedBy: a.reportedBy }),
          ...(a.reportedAt !== undefined && { reportedAt: a.reportedAt }),
          ...(a.notes !== undefined && { notes: a.notes }),
          attachments: a.attachments ?? [],
        })),
    },
    didItWork: worked.view,
    ...(worked.attempt !== undefined && { verification: verificationView(worked.attempt) }),
    verificationHistory: attempts.map((a) => ({
      verificationId: a.verificationId,
      status: a.status,
      ...(a.assessment !== undefined && { result: a.assessment.result }),
      ...(a.evaluatedAt !== undefined && { evaluatedAt: a.evaluatedAt }),
    })),
    stayingFixed: {
      watch:
        c.state === "VERIFIED_IMPROVED" && watchEnds !== undefined
          ? Date.parse(input.caseRecord.updatedAt) <= Date.parse(watchEnds)
            ? "WATCHING"
            : "WATCH_ENDED"
          : "NOT_ACTIVE",
      ...(c.state === "VERIFIED_IMPROVED" && watchEnds !== undefined && { watchEndsAt: watchEnds }),
      recurrenceCount: c.recurrenceCount,
      ...(lastRecurrence !== undefined && {
        lastRecurrence: {
          at: lastRecurrence.at,
          riskEventId: String(lastRecurrence.details?.newRiskEventId ?? ""),
        },
      }),
    },
    ...(currentIntervention !== undefined && {
      intervention: {
        interventionId: currentIntervention.interventionId,
        level: currentIntervention.level,
        label: INTERVENTION_LABELS[currentIntervention.level],
        status: currentIntervention.status,
        policyId: currentIntervention.policyId,
        policyVersion: currentIntervention.policyVersion,
        reasonCodes: currentIntervention.reasonCodes,
        dataSufficiency: currentIntervention.dataSufficiency,
        generatedAt: currentIntervention.generatedAt,
      },
    }),
    evidence: {
      auditReferences: audit.map((e) => ({ auditId: e.auditId, action: e.action, at: e.at })),
    },
    sharing: { label: "Not available until S6" },
  };
}
