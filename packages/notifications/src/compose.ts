import type { AlertKind, RiskImprovementCase } from "@symbiosis/contracts";

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

export type ComposedAlert = {
  readonly subject: string;
  readonly body: string;
  readonly summary: string;
};

/**
 * Builds the alert text from deterministic case facts. It deliberately contains no raw
 * telemetry, no secrets and no one-click action token (forwardable action links are a later
 * security concern). `casePath` is a local path placeholder, not a credential.
 */
export function composeAlert(input: {
  readonly caseRecord: RiskImprovementCase;
  readonly kind: AlertKind;
  readonly reasonCodes: readonly string[];
  readonly casePath: string;
}): ComposedAlert {
  const c = input.caseRecord;
  const primary = c.assetIds[0] ?? "unknown asset";
  const reasons = describeReasonCodes(input.reasonCodes);
  const summary =
    `${c.severity} ${c.hazardType} on ${primary}` +
    (reasons.length > 0 ? `: ${reasons.join("; ")}` : "");
  const prefix = input.kind === "ESCALATION" ? "ESCALATION" : "ALERT";
  const subject = `[${prefix}] [${c.severity}] ${c.title}`;
  const body = [
    input.kind === "ESCALATION"
      ? "This risk was not acknowledged in time and has been escalated."
      : "A risk requires attention.",
    `Severity: ${c.severity}`,
    `Hazard: ${c.hazardType}`,
    `Facility: ${c.facilityId}`,
    `Assets: ${c.assetIds.join(", ")}`,
    `Case: ${c.caseId}`,
    `Risk event: ${c.activeRiskEventId ?? "n/a"}`,
    `What happened: ${summary}`,
    ...reasons.map((r) => `  - ${r}`),
    "Action required: acknowledge the case and review the approved actions.",
    "Note: reporting an action is not proof that the risk improved; sensors must confirm.",
    `Open: ${input.casePath}`,
  ].join("\n");
  return { subject, body, summary };
}
