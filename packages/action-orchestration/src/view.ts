import type {
  Alert,
  AlertStatus,
  AuditEntry,
  CaseSeverity,
  CaseState,
  MitigationAction,
  RiskEvent,
  RiskEventState,
  RiskImprovementCase,
} from "@symbiosis/contracts";
import { describeReasonCodes } from "@symbiosis/notifications";
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

export const VERIFICATION_PENDING_LABEL = "VERIFICATION PENDING";

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
    readonly status: "NOT_APPLICABLE_YET" | "VERIFICATION_PENDING" | "NOT_AVAILABLE_IN_THIS_BUILD";
    readonly label: string;
    readonly detail: string;
  };
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

function didItWork(state: CaseState): CaseView["didItWork"] {
  if (state === "ACTION_REPORTED") {
    return {
      status: "VERIFICATION_PENDING",
      label: VERIFICATION_PENDING_LABEL,
      detail:
        "An action was reported. A report is not evidence that the risk improved: only new sensor readings can show that, and that check is not available until S5.",
    };
  }
  if (state === "OPEN" || state === "ACTION_REQUIRED" || state === "REOPENED") {
    return {
      status: "NOT_APPLICABLE_YET",
      label: "NO ACTION REPORTED YET",
      detail: "Nothing to check yet: no action has been reported for this case.",
    };
  }
  return {
    status: "NOT_AVAILABLE_IN_THIS_BUILD",
    label: "RESULT NOT AVAILABLE IN THIS BUILD",
    detail: "Sensor-based checking arrives in a later phase.",
  };
}

export function buildCaseView(input: {
  readonly caseRecord: RiskImprovementCase;
  readonly event?: RiskEvent;
  readonly actions: readonly MitigationAction[];
  readonly alerts: readonly Alert[];
  readonly audit: readonly AuditEntry[];
  readonly library: ActionLibrary;
}): CaseView {
  const { caseRecord: c, event, actions, alerts, audit, library } = input;
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
    didItWork: didItWork(c.state),
    evidence: {
      auditReferences: audit.map((e) => ({ auditId: e.auditId, action: e.action, at: e.at })),
    },
    sharing: { label: "Not available until S6" },
  };
}
