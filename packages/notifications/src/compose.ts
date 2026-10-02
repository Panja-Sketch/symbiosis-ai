import type { AlertKind, AlertTrigger, RiskImprovementCase } from "@symbiosis/contracts";

/**
 * Deterministic, rule-based wording for machine reason codes. This is a static lookup, not
 * generated text: the authoritative facts are always the codes themselves (spec principle 1).
 */
const REASON_PHRASES: Readonly<Record<string, string>> = {
  VIBRATION_Z_AT_OR_ABOVE_THRESHOLD: "vibration is well above its learned baseline",
  CURRENT_DEVIATION_AT_OR_ABOVE_THRESHOLD: "electrical current is above its learned baseline",
  OUTDOOR_HEAT_CONTEXT: "outdoor heat is above the configured limit",
  ZONE_TEMPERATURE_RISING: "the zone temperature is rising",
  VIBRATION_ABNORMAL: "vibration is abnormal",
  CURRENT_ABNORMAL: "current is abnormal",
};

export function describeReasonCode(code: string): string {
  const persisted = /^PERSISTED_(\d+)_OF_(\d+)$/.exec(code);
  if (persisted)
    return `the condition persisted for ${persisted[1]} of ${persisted[2]} required checks`;
  return REASON_PHRASES[code] ?? code;
}

export function describeReasonCodes(codes: readonly string[]): string[] {
  return codes.map(describeReasonCode);
}

/** One criterion of a completed verification, as plain facts (no raw telemetry). */
export type VerificationDigestCriterion = {
  readonly name: string;
  readonly outcome: "PASS" | "FAIL" | "INSUFFICIENT";
  readonly required: boolean;
  readonly note?: string;
};

export type VerificationDigest = {
  readonly verificationId: string;
  readonly result: string;
  readonly resultLabel: string;
  readonly policy: string;
  readonly completeness: number;
  readonly confidence: number;
  readonly evaluatedAt: string;
  readonly criteria: readonly VerificationDigestCriterion[];
};

/** Facts about the surroundings of an alert, supplied by the composition root. */
export type AlertComposeExtras = {
  readonly facilityName?: string;
  readonly assetNames?: Readonly<Record<string, string>>;
  /** Absolute link to the case in the web app (sign-in required); never a credential. */
  readonly caseUrl?: string;
  readonly detectedAt?: string;
  /** Titles from the approved action library. */
  readonly approvedActions?: readonly string[];
  readonly reportedActions?: readonly { title: string; reportedAt: string }[];
  readonly verification?: VerificationDigest;
  readonly statusLabel?: string;
};

export type ComposedAlert = {
  readonly subject: string;
  readonly body: string;
  readonly summary: string;
};

const utc = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
};

const TRIGGER_HEADLINES: Readonly<Record<string, string>> = {
  VERIFICATION_NOT_IMPROVING:
    "Follow-up: the reported action did not improve the physical condition.",
  VERIFICATION_PARTIALLY_VERIFIED:
    "Follow-up: the condition improved but did not reach the verification target.",
  VERIFICATION_INCONCLUSIVE: "Follow-up: sensors could not confirm whether the condition improved.",
  ACTION_OVERDUE: "Follow-up: an assigned action has not been reported.",
  RECURRENCE: "Recurrence: a risk that was verified as improved has returned.",
};

/**
 * Builds the alert text from deterministic case facts. It deliberately contains no raw telemetry,
 * no secrets, no signature material and no one-click action token (a forwardable link must never
 * act): the link opens the signed-in case page. Nothing about an insurer appears here.
 */
export function composeAlert(input: {
  readonly caseRecord: RiskImprovementCase;
  readonly kind: AlertKind;
  readonly reasonCodes: readonly string[];
  readonly casePath: string;
  readonly trigger?: AlertTrigger;
  readonly extras?: AlertComposeExtras;
}): ComposedAlert {
  const c = input.caseRecord;
  const x = input.extras ?? {};
  const names = x.assetNames ?? {};
  const primary = names[c.assetIds[0] ?? ""] ?? c.assetIds[0] ?? "unknown asset";
  const reasons = describeReasonCodes(input.reasonCodes);
  const summary =
    `${c.severity} ${c.hazardType} on ${primary}` +
    (reasons.length > 0 ? `: ${reasons.join("; ")}` : "");
  const recurrence = input.trigger?.type === "RECURRENCE";
  const prefix =
    input.kind === "ESCALATION"
      ? "ESCALATION"
      : input.kind === "FOLLOW_UP"
        ? "FOLLOW-UP"
        : recurrence
          ? "RECURRENCE"
          : "ALERT";
  const where = x.facilityName !== undefined ? ` · ${x.facilityName}` : "";
  const subject = `[${prefix}] [${c.severity}] ${c.title}${where}`;

  const lines: string[] = [];
  if (input.kind === "ESCALATION") {
    lines.push("This risk was not acknowledged in time and has been escalated.");
  } else if (input.kind === "FOLLOW_UP") {
    lines.push(
      TRIGGER_HEADLINES[input.trigger?.type ?? ""] ?? "Follow-up on an open risk.",
      ...(input.trigger !== undefined ? [`Why you are receiving this: ${input.trigger.why}`] : []),
    );
  } else if (recurrence) {
    lines.push(TRIGGER_HEADLINES.RECURRENCE as string);
  } else {
    lines.push("A risk requires attention.");
  }
  lines.push(
    `Severity: ${c.severity}`,
    `Hazard: ${c.hazardType}`,
    ...(x.facilityName !== undefined
      ? [`Facility: ${x.facilityName} (${c.facilityId})`]
      : [`Facility: ${c.facilityId}`]),
    `Assets: ${c.assetIds.map((a) => names[a] ?? a).join(", ")}`,
    ...(x.detectedAt !== undefined ? [`Detected: ${utc(x.detectedAt)}`] : []),
    `Case: ${c.caseId}`,
    `Risk event: ${c.activeRiskEventId ?? "n/a"}`,
    `What happened: ${summary}`,
    ...reasons.map((r) => `  - ${r}`),
  );
  if (x.statusLabel !== undefined) lines.push(`Current status: ${x.statusLabel}`);
  if (c.recurrenceCount > 0) lines.push(`Recurrences so far: ${c.recurrenceCount}`);

  if (input.kind === "FOLLOW_UP") {
    if ((x.reportedActions?.length ?? 0) > 0) {
      lines.push("What was reported:");
      for (const a of x.reportedActions ?? []) {
        lines.push(`  - ${a.title} (reported ${utc(a.reportedAt)})`);
      }
    }
    if (x.verification !== undefined) {
      const v = x.verification;
      lines.push(
        `Verification result: ${v.resultLabel} (evaluated ${utc(v.evaluatedAt)})`,
        `Evidence completeness ${Math.round(v.completeness * 100)}%, confidence ${Math.round(v.confidence * 100)}%, policy ${v.policy}`,
        "What the sensors show:",
      );
      for (const k of v.criteria) {
        lines.push(
          `  - ${k.name}: ${k.outcome}${k.required ? "" : " (supporting)"}${k.note !== undefined ? ` - ${k.note}` : ""}`,
        );
      }
    }
    lines.push(
      "A reported action is evidence that something was done, not evidence that the risk improved.",
    );
  }

  if ((x.approvedActions?.length ?? 0) > 0) {
    lines.push("Recommended approved actions:");
    for (const t of x.approvedActions ?? []) lines.push(`  - ${t}`);
  }
  lines.push(
    input.kind === "FOLLOW_UP"
      ? "Action required: review the sensor evidence and report a further approved action if one is needed."
      : "Action required: acknowledge the case and review the approved actions.",
    "Note: reporting an action is not proof that the risk improved; sensors must confirm.",
    `Open: ${x.caseUrl ?? input.casePath}${x.caseUrl !== undefined ? " (sign-in required)" : ""}`,
  );
  return { subject, body: lines.join("\n"), summary };
}
