import {
  INTERVENTION_INFO,
  INTERVENTION_NOTE,
  INTERVENTION_ORDER,
  interventionReason,
} from "../lib/labels";
import type { InterventionLevel } from "../lib/types";
import { Meter, ToneBadge } from "./ui";

export type InterventionView = {
  readonly level: string;
  readonly status: string;
  readonly reasonCodes: readonly string[];
  readonly dataSufficiency: number;
  readonly policyId?: string;
  readonly policyVersion?: string;
};

const LEVEL_TONE: Readonly<Record<InterventionLevel, "good" | "info" | "warn" | "danger">> = {
  REMOTE_MONITORING: "good",
  REMOTE_REVIEW: "info",
  RISK_ENGINEER_REVIEW: "warn",
  SITE_VISIT_RECOMMENDED: "danger",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: "Active recommendation",
  ACKNOWLEDGED: "Acknowledged",
  SUPERSEDED: "Superseded",
  RESOLVED: "Resolved",
};

/**
 * The deterministic risk-engineer intervention recommendation. It is decision support: the wording
 * is always "recommended", never "scheduled", "assigned" or "dispatched", because Symbiosis does
 * none of those things.
 */
export function InterventionPanel({
  intervention,
  supportingEvidenceCount,
}: {
  readonly intervention: InterventionView;
  /** Records in the evidence package behind the recommendation, when the viewer may know it. */
  readonly supportingEvidenceCount?: number | undefined;
}) {
  const level = INTERVENTION_ORDER.includes(intervention.level as InterventionLevel)
    ? (intervention.level as InterventionLevel)
    : undefined;
  const info = level === undefined ? undefined : INTERVENTION_INFO[level];
  return (
    <div className="intervention" data-level={intervention.level}>
      <div className="intervention-head">
        <ToneBadge tone={level === undefined ? "neutral" : LEVEL_TONE[level]} icon="◆">
          {info?.label ?? intervention.level}
        </ToneBadge>
        <span className="muted">
          {STATUS_LABELS[intervention.status] ?? intervention.status.toLowerCase()}
        </span>
      </div>
      {info !== undefined && <p>{info.meaning}</p>}
      <ol className="ladder" aria-label="Recommendation levels">
        {INTERVENTION_ORDER.map((l) => (
          <li
            key={l}
            className={l === level ? "ladder-current" : ""}
            {...(l === level ? { "aria-current": "step" as const } : {})}
          >
            {INTERVENTION_INFO[l].label}
          </li>
        ))}
      </ol>
      <h3>Why this level</h3>
      <ul className="plain-list">
        {intervention.reasonCodes.map((c) => (
          <li key={c}>{interventionReason(c)}</li>
        ))}
      </ul>
      <Meter value={intervention.dataSufficiency} label="Evidence sufficiency" />
      <p className="muted">
        {supportingEvidenceCount !== undefined && (
          <>Supporting evidence: {supportingEvidenceCount} records in the evidence package. </>
        )}
        {intervention.policyId !== undefined && (
          <>
            Policy {intervention.policyId} v{intervention.policyVersion}.
          </>
        )}
      </p>
      <p className="note">{INTERVENTION_NOTE}</p>
    </div>
  );
}
