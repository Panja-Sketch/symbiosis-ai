import Link from "next/link";
import type { ReactNode } from "react";
import {
  acknowledgeActionAction,
  acknowledgeCaseAction,
  assignActionAction,
  reportActionAction,
} from "../app/actions";
import { formatTime, formatValue } from "../lib/format";
import { personLabel } from "../lib/identity";
import type { OrgNames, People, Session } from "../lib/identity";
import {
  SEVERITY_MEANING,
  STATUS,
  STATUS_FOR_DID_IT_WORK,
  STATUS_FOR_RESULT,
  criterionLabel,
  detectionReason,
  flowStageFor,
  hazardLabel,
  outcomeLabel,
  statusForState,
  verificationReason,
} from "../lib/labels";
import type { CaseData } from "../lib/loaders";
import type { ActionDto, CaseDto, IdentityDto, OrganizationDto } from "../lib/types";
import { BeforeAfter } from "./BeforeAfter";
import type { CompareItem } from "./BeforeAfter";
import { EvidencePanel } from "./EvidencePanel";
import { FlowStrip } from "./FlowStrip";
import { InterventionPanel } from "./InterventionPanel";
import { SharingPanel } from "./SharingPanel";
import { Timeline } from "./Timeline";
import { TrustExplainer } from "./TrustExplainer";
import {
  Meter,
  Notice,
  PageHeader,
  Section,
  SeverityBadge,
  StatusBadge,
  SyntheticBadge,
  ToneBadge,
} from "./ui";

const HAZARD_EXPLAINER: Readonly<Record<string, string>> = {
  COOLING_ELECTRICAL_DETERIORATION:
    "Cooling equipment is showing abnormal vibration and electrical current, with heat context or a rising zone temperature, for several checks in a row. It is a risk signal for a person to look at, not a prediction of loss.",
};

const NEXT_STEP: Readonly<Record<string, string>> = {
  OPEN: "Acknowledge this risk so someone owns it, then assign or report an approved action.",
  ACTION_REQUIRED: "Assign an approved action, or have the assignee acknowledge and report it.",
  ACTION_REPORTED:
    "Nothing more to do now. The action is reported, not proven: Symbiosis is waiting for trusted sensor readings.",
  VERIFYING: "Nothing more to do now. Verification is collecting trusted post-action readings.",
  VERIFIED_IMPROVED: "The improvement is verified. Share the evidence if an insurer should see it.",
  PARTIALLY_VERIFIED: "Readings improved but not to target. Consider a further approved action.",
  NOT_IMPROVING:
    "The condition is not improving. Report a further approved action and seek review.",
  INCONCLUSIVE:
    "The evidence could not settle it. Check the devices, then report a follow-up action.",
  REOPENED: "The hazard returned after a verified improvement. Acknowledge the new alert.",
  CLOSED: "This case is closed.",
};

type Props = {
  readonly data: CaseData;
  readonly session: Session;
  readonly people: People;
  readonly orgNames: OrgNames;
  /** Colleagues of the signed-in identity who can be assigned an action (same organization). */
  readonly assignees: readonly IdentityDto[];
  readonly insurers: readonly OrganizationDto[];
  readonly notice?: string | undefined;
  readonly error?: string | undefined;
  /** Streamed plain-language summary (S8); the deterministic sections never wait for it. */
  readonly explanationSlot?: ReactNode;
};

export const SECTION_LINKS: readonly (readonly [string, string])[] = [
  ["what-happened", "What happened"],
  ["why-it-matters", "Why it matters"],
  ["what-to-do", "What to do"],
  ["accountability", "Accountability"],
  ["what-was-done", "What was done"],
  ["did-it-work", "Did it work?"],
  ["explanation", "Plain-language summary"],
  ["staying-fixed", "Is it staying fixed?"],
  ["evidence", "Evidence"],
  ["sharing", "Sharing"],
  ["timeline", "Timeline"],
];

function actionState(
  libraryId: string,
  done: readonly ActionDto[],
): {
  readonly label: string;
  readonly tone: "info" | "warn" | "good" | "neutral";
  readonly icon: string;
} {
  const mine = done.filter((a) => a.actionLibraryId === libraryId);
  const reported = mine.find((a) => a.status === "REPORTED_COMPLETE");
  if (reported !== undefined) return { label: "Reported complete", tone: "good", icon: "✓" };
  if (mine.some((a) => a.status === "ACKNOWLEDGED"))
    return { label: "Acknowledged", tone: "info", icon: "◔" };
  if (mine.length > 0) return { label: "Assigned", tone: "warn", icon: "▲" };
  return { label: "Recommended · available", tone: "neutral", icon: "○" };
}

function compareItems(c: CaseDto): readonly CompareItem[] {
  return (c.verification?.criteria ?? []).map((x) => ({
    criterionId: x.criterionId,
    role: x.role,
    outcome: x.outcome,
    ...(x.signal !== undefined && { signal: x.signal }),
    ...(x.metric !== undefined && { metric: x.metric }),
    ...(x.before !== undefined && { before: x.before }),
    ...(x.observed !== undefined && { after: x.observed }),
    reasonCodes: x.reasonCodes,
  }));
}

function WhatHappened({ c }: { readonly c: CaseDto }) {
  const risk = (c.verification?.criteria ?? []).filter((x) => x.before?.mean !== undefined);
  return (
    <Section
      id="what-happened"
      number={1}
      title="What happened"
      question="What did the system detect?"
    >
      <p className="emphasis">
        {hazardLabel(c.hazardType)} on {c.assetIds[0] ?? "an asset"}
      </p>
      <ul className="plain-list" aria-label="Detection reasons">
        {c.reasonCodes.map((code) => (
          <li key={code}>{detectionReason(code)}</li>
        ))}
      </ul>
      <dl className="kv">
        <div>
          <dt>Latest detection</dt>
          <dd>{formatTime(c.latestDetectionAt)}</dd>
        </div>
        <div>
          <dt>Detections recorded</dt>
          <dd>{c.detectionCount}</dd>
        </div>
        <div>
          <dt>Facility</dt>
          <dd>{c.facilityId}</dd>
        </div>
        <div>
          <dt>Affected assets</dt>
          <dd>{c.assetIds.join(", ")}</dd>
        </div>
        <div>
          <dt>Severity</dt>
          <dd>
            <SeverityBadge severity={c.severity} />
          </dd>
        </div>
        <div>
          <dt>Risk event</dt>
          <dd>
            {c.riskEventId ?? "—"}
            {c.riskEventState !== undefined && (
              <span className="cell-sub">{c.riskEventState.toLowerCase().replace(/_/g, " ")}</span>
            )}
          </dd>
        </div>
      </dl>
      {risk.length > 0 ? (
        <>
          <h3>Readings during the risk period</h3>
          <ul className="plain-list">
            {risk.map((x) => (
              <li key={x.criterionId}>
                {criterionLabel(x.criterionId).replace(/ back within target$/, "")}: mean{" "}
                <strong>{formatValue(x.before?.mean)}</strong>
                {x.before?.max !== undefined && (
                  <> (highest {formatValue(x.before.max)})</>
                )} over {x.before?.sampleCount} readings
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted">
          Risk-period readings are summarised once verification runs; raw telemetry is not shown
          here.
        </p>
      )}
    </Section>
  );
}

function WhyItMatters({ c }: { readonly c: CaseDto }) {
  return (
    <Section
      id="why-it-matters"
      number={2}
      title="Why it matters"
      question="How much should I care?"
    >
      <p>{SEVERITY_MEANING[c.severity]}</p>
      <p>
        {HAZARD_EXPLAINER[c.hazardType] ??
          "A persistent abnormal pattern was found by a deterministic rule."}
      </p>
      {c.intervention !== undefined && (
        <>
          <h3>Current risk-engineer recommendation</h3>
          <InterventionPanel intervention={c.intervention} />
        </>
      )}
      <p className="muted">
        This release does not estimate financial loss. Severity and the recommendation come from
        versioned deterministic rules.
      </p>
    </Section>
  );
}

function WhatToDo({
  c,
  session,
  assignees,
  people,
}: {
  readonly c: CaseDto;
  readonly session: Session;
  readonly assignees: readonly IdentityDto[];
  readonly people: People;
}) {
  const canAssign =
    c.nextSteps.canAssignOrReport &&
    session.permissions.includes("ACTION_ASSIGN") &&
    assignees.length > 0;
  return (
    <Section
      id="what-to-do"
      number={3}
      title="What to do"
      question="What are the approved options?"
    >
      <p className="note">
        Recommendations only. A person carries out any action and reports it; Symbiosis never
        operates or controls equipment.
      </p>
      <ul className="actions" aria-label="Approved actions">
        {c.whatToDo.approvedActions.map((a) => {
          const st = actionState(a.actionLibraryId, c.whatWasDone.actions);
          return (
            <li
              key={a.actionLibraryId}
              data-action-library-id={a.actionLibraryId}
              data-action-state={st.label}
            >
              <div className="action-head">
                <strong>{a.title}</strong>
                <ToneBadge tone={st.tone} icon={st.icon}>
                  {st.label}
                </ToneBadge>
              </div>
              <p className="muted">{a.description}</p>
              {canAssign && a.status === "AVAILABLE" && (
                <form action={assignActionAction} className="inline-form">
                  <input type="hidden" name="caseId" value={c.caseId} />
                  <input type="hidden" name="actionLibraryId" value={a.actionLibraryId} />
                  <label>
                    <span className="visually-hidden">Assign “{a.title}” to</span>
                    <select
                      name="assigneeId"
                      defaultValue={assignees[0]?.actorId}
                      aria-label={`Assign ${a.title} to`}
                    >
                      {assignees.map((p) => (
                        <option key={p.actorId} value={p.actorId}>
                          {personLabel(people, p.actorId)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="btn btn-small">
                    Assign
                  </button>
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Accountability({
  c,
  session,
  people,
}: {
  readonly c: CaseDto;
  readonly session: Session;
  readonly people: People;
}) {
  const a = c.accountability;
  const canAck = c.nextSteps.canAcknowledge && session.permissions.includes("CASE_ACKNOWLEDGE");
  return (
    <Section id="accountability" number={4} title="Accountability" question="Who owns this?">
      <dl className="kv">
        <div>
          <dt>Owner</dt>
          <dd>{personLabel(people, a.ownerId)}</dd>
        </div>
        <div>
          <dt>Alert</dt>
          <dd>
            {a.alert.status === "SENT" ? (
              <ToneBadge tone="good" icon="✓">
                Sent to {personLabel(people, a.alert.recipient)}
              </ToneBadge>
            ) : a.alert.status === "FAILED" ? (
              <ToneBadge tone="danger" icon="✕">
                Delivery failed{a.alert.exhausted ? " (retries exhausted)" : ""}
              </ToneBadge>
            ) : (
              <ToneBadge tone="neutral" icon="–">
                {a.alert.status === "NOT_REQUESTED" ? "No alert requested" : "Alert requested"}
              </ToneBadge>
            )}
            {a.alert.sentAt !== undefined && (
              <span className="cell-sub">
                {formatTime(a.alert.sentAt)} · {a.alert.attempts} attempt(s)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>Acknowledgement</dt>
          <dd>
            {a.acknowledgement.acknowledged && !c.nextSteps.canAcknowledge ? (
              <>
                <ToneBadge tone="good" icon="✓">
                  Acknowledged
                </ToneBadge>
                <span className="cell-sub">
                  {personLabel(people, a.acknowledgement.by)} · {formatTime(a.acknowledgement.at)}
                </span>
              </>
            ) : (
              <ToneBadge tone="warn" icon="▲">
                Awaiting acknowledgement
              </ToneBadge>
            )}
          </dd>
        </div>
        <div>
          <dt>Escalation</dt>
          <dd>
            {a.escalation.escalated ? (
              <>
                <ToneBadge tone="danger" icon="↑">
                  Escalated
                </ToneBadge>
                <span className="cell-sub">{formatTime(a.escalation.at)}</span>
              </>
            ) : (
              "Not escalated"
            )}
          </dd>
        </div>
      </dl>
      {canAck && (
        <form action={acknowledgeCaseAction} className="inline-form">
          <input type="hidden" name="caseId" value={c.caseId} />
          <button type="submit" className="btn btn-primary">
            Acknowledge this risk
          </button>
        </form>
      )}
    </Section>
  );
}

function WhatWasDone({
  c,
  session,
  people,
}: {
  readonly c: CaseDto;
  readonly session: Session;
  readonly people: People;
}) {
  const acts = c.whatWasDone.actions;
  return (
    <Section id="what-was-done" number={5} title="What was done" question="What did people report?">
      {acts.length === 0 ? (
        <p className="muted">No action has been assigned or reported yet.</p>
      ) : (
        <ul className="actions" aria-label="Actions taken">
          {acts.map((a) => {
            const canAck =
              a.status === "ASSIGNED" &&
              a.assignedTo === session.actorId &&
              session.permissions.includes("ACTION_ACKNOWLEDGE");
            const canReport =
              (a.status === "ASSIGNED" || a.status === "ACKNOWLEDGED") &&
              c.nextSteps.canAssignOrReport &&
              session.permissions.includes("ACTION_REPORT");
            return (
              <li key={a.actionId} data-action-status={a.status}>
                <div className="action-head">
                  <strong>{a.title}</strong>
                  <ToneBadge
                    tone={a.status === "REPORTED_COMPLETE" ? "good" : "warn"}
                    icon={a.status === "REPORTED_COMPLETE" ? "✓" : "▲"}
                  >
                    {a.status === "REPORTED_COMPLETE"
                      ? "Reported complete"
                      : a.status === "ACKNOWLEDGED"
                        ? "Acknowledged"
                        : "Assigned"}
                  </ToneBadge>
                </div>
                <p className="muted">
                  Assigned to {personLabel(people, a.assignedTo)}
                  {a.reportedAt !== undefined && (
                    <>
                      {" "}
                      · reported by {personLabel(people, a.reportedBy)} at{" "}
                      {formatTime(a.reportedAt)}
                    </>
                  )}
                </p>
                {a.notes !== undefined && a.notes !== "" && (
                  <blockquote className="note-quote">{a.notes}</blockquote>
                )}
                {a.status === "REPORTED_COMPLETE" && (
                  <p className="note">
                    Reported complete is what a person said. It is not proof the risk improved.
                  </p>
                )}
                {canAck && (
                  <form action={acknowledgeActionAction} className="inline-form">
                    <input type="hidden" name="caseId" value={c.caseId} />
                    <input type="hidden" name="actionId" value={a.actionId} />
                    <button type="submit" className="btn btn-small">
                      Acknowledge assignment
                    </button>
                  </form>
                )}
                {canReport && (
                  <form action={reportActionAction} className="report-form">
                    <input type="hidden" name="caseId" value={c.caseId} />
                    <input type="hidden" name="actionId" value={a.actionId} />
                    <input type="hidden" name="actionLibraryId" value={a.actionLibraryId} />
                    <label className="field">
                      Notes (optional)
                      <textarea name="notes" rows={2} maxLength={2000} />
                    </label>
                    <button type="submit" className="btn btn-primary btn-small">
                      Report this action complete
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function ReportedVsVerified({ c }: { readonly c: CaseDto }) {
  const reported = c.whatWasDone.actions.find((a) => a.status === "REPORTED_COMPLETE");
  const key = STATUS_FOR_DID_IT_WORK[c.didItWork.status];
  return (
    <div className="two-states" role="group" aria-label="Reported versus verified">
      <div className="two-states-cell">
        <span className="two-states-title">Reported complete</span>
        <strong>{reported !== undefined ? "Yes, by a person" : "Not yet"}</strong>
        <span className="muted">
          {reported?.reportedAt !== undefined
            ? formatTime(reported.reportedAt)
            : "No action reported"}
        </span>
      </div>
      <div className="two-states-cell">
        <span className="two-states-title">Verified improved</span>
        <strong>
          {c.didItWork.status === "VERIFIED_IMPROVED" ? "Yes, by sensors" : "Not verified"}
        </strong>
        <span className="muted">
          {key === undefined ? "Nothing to verify yet" : STATUS[key].label}
        </span>
      </div>
    </div>
  );
}

function DidItWork({ c }: { readonly c: CaseDto }) {
  const v = c.verification;
  const key = STATUS_FOR_DID_IT_WORK[c.didItWork.status];
  const done = v?.status === "COMPLETED";
  return (
    <Section
      id="did-it-work"
      number={6}
      title="Did it work?"
      question="Did the sensors confirm the improvement?"
      wide
    >
      <ReportedVsVerified c={c} />
      <div className="verdict" data-did-it-work={c.didItWork.status}>
        {key !== undefined ? (
          <StatusBadge status={key} label={c.didItWork.label} size="lg" />
        ) : (
          <span className="badge tone-neutral badge-lg">
            <span>{c.didItWork.label}</span>
          </span>
        )}
        <p>{c.didItWork.detail}</p>
      </div>
      {v !== undefined && !done && (
        <p className="muted">
          Collecting trusted readings from {formatTime(v.postActionWindow.start)} until{" "}
          {formatTime(v.postActionWindow.end)} ({v.policyId} v{v.policyVersion}). Nothing is
          concluded before the window ends.
        </p>
      )}
      {v !== undefined && done && (
        <>
          <dl className="kv">
            <div>
              <dt>Policy</dt>
              <dd>
                {v.policyId} v{v.policyVersion}
              </dd>
            </div>
            <div>
              <dt>Evaluated</dt>
              <dd>{formatTime(v.evaluatedAt)}</dd>
            </div>
            <div>
              <dt>Post-action window</dt>
              <dd>
                {formatTime(v.postActionWindow.start)} to {formatTime(v.postActionWindow.end)}
              </dd>
            </div>
            <div>
              <dt>Evidence records</dt>
              <dd>{v.evidenceReferenceCount}</dd>
            </div>
          </dl>
          <div className="meters">
            {v.confidence !== undefined && <Meter value={v.confidence} label="Confidence" />}
            {v.dataCompleteness !== undefined && (
              <Meter value={v.dataCompleteness} label="Data completeness" />
            )}
            {v.telemetryConfidence !== undefined && (
              <Meter value={v.telemetryConfidence} label="Telemetry confidence" />
            )}
          </div>
          <p className="muted">
            Device health: {v.deviceHealthStatus?.toLowerCase()} · authenticity:{" "}
            {v.authIntegrityStatus?.toLowerCase()}
          </p>
          <h3>Before and after the action</h3>
          <BeforeAfter items={compareItems(c)} />
          <h3>Why this result</h3>
          <ul className="plain-list">
            {v.reasonCodes.map((r) => (
              <li key={r}>{verificationReason(r)}</li>
            ))}
          </ul>
          <details className="history">
            <summary>Criterion results ({v.criteria.length})</summary>
            <table className="mini-table">
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Role</th>
                  <th scope="col">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {v.criteria.map((x) => (
                  <tr key={x.criterionId}>
                    <th scope="row">{criterionLabel(x.criterionId)}</th>
                    <td>{x.role === "SUPPORTING" ? "Supporting" : "Required"}</td>
                    <td>{outcomeLabel(x.outcome)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </Section>
  );
}

function StayingFixed({ c }: { readonly c: CaseDto }) {
  const s = c.stayingFixed;
  const st = statusForState(c.state);
  const history = c.verificationHistory.filter((h) => h.status === "COMPLETED");
  return (
    <Section
      id="staying-fixed"
      number={7}
      title="Is it staying fixed?"
      question="Has the hazard come back?"
    >
      <dl className="kv">
        <div>
          <dt>Recurrence watch</dt>
          <dd>
            {s.watch === "WATCHING"
              ? `Watching until ${formatTime(s.watchEndsAt)}`
              : s.watch === "WATCH_ENDED"
                ? "Watch ended"
                : "Not active (starts once an improvement is verified)"}
          </dd>
        </div>
        <div>
          <dt>Recurrences</dt>
          <dd data-testid="recurrence-count">{s.recurrenceCount}</dd>
        </div>
        <div>
          <dt>Last recurrence</dt>
          <dd>{s.lastRecurrence !== undefined ? formatTime(s.lastRecurrence.at) : "None"}</dd>
        </div>
        <div>
          <dt>Current case state</dt>
          <dd>
            <StatusBadge status={st.key} />
          </dd>
        </div>
        <div>
          <dt>Latest risk event</dt>
          <dd>
            {c.riskEventId ?? "—"}
            {c.riskEventState !== undefined && (
              <span className="cell-sub">{c.riskEventState.toLowerCase().replace(/_/g, " ")}</span>
            )}
          </dd>
        </div>
      </dl>
      {(s.recurrenceCount > 0 || c.state === "REOPENED") && (
        <div className="reopened" data-testid="reopened-history">
          <h3>This case was reopened</h3>
          <p>
            The hazard returned after a verified improvement
            {s.lastRecurrence !== undefined && <> (at {formatTime(s.lastRecurrence.at)})</>}. It is
            the same case, so the history stays in one place: a new risk event was opened
            {s.lastRecurrence?.riskEventId ? (
              <>
                {" "}
                (<code>{s.lastRecurrence.riskEventId}</code>)
              </>
            ) : null}
            , and earlier verification results are kept.
          </p>
          <ol className="plain-list">
            {history.map((h) => {
              const k = h.result === undefined ? undefined : STATUS_FOR_RESULT[h.result];
              return (
                <li key={h.verificationId}>
                  {k !== undefined ? STATUS[k].label : "Verification"} · {formatTime(h.evaluatedAt)}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </Section>
  );
}

/** The full facility-side case detail: the nine questions of spec section 25, then the timeline. */
export function CaseDetail({
  data,
  session,
  people,
  orgNames,
  assignees,
  insurers,
  notice,
  error,
  explanationSlot,
}: Props) {
  const c = data.case;
  const st = statusForState(c.state);
  const returnTo = `/operations/cases/${encodeURIComponent(c.caseId)}`;
  const source = data.evidence?.package.payload.source;
  return (
    <>
      <p className="crumbs">
        <Link href="/operations">← All cases</Link>
      </p>
      <PageHeader
        title={`${hazardLabel(c.hazardType)} · ${c.assetIds[0] ?? ""}`}
        lead={
          <>
            Case <code>{c.caseId}</code> · {c.facilityId}
          </>
        }
      >
        <div className="header-badges">
          <StatusBadge status={st.key} size="lg" />
          <SeverityBadge severity={c.severity} />
          {source?.synthetic === true && <SyntheticBadge label={source.label} />}
        </div>
      </PageHeader>
      <FlowStrip current={flowStageFor(c)} />
      <Notice notice={notice} error={error} />
      <p className="next-step" data-testid="next-step">
        <strong>Next:</strong>{" "}
        {c.state === "OPEN" && !c.nextSteps.canAcknowledge
          ? "Assign an approved action, or report one that has been carried out."
          : (NEXT_STEP[c.state] ?? "")}
      </p>
      <nav className="page-nav" aria-label="On this page">
        <ul>
          {SECTION_LINKS.map(([id, label]) => (
            <li key={id}>
              <a href={`#${id}`}>{label}</a>
            </li>
          ))}
        </ul>
      </nav>
      <div className="sections">
        <WhatHappened c={c} />
        <WhyItMatters c={c} />
        <WhatToDo c={c} session={session} assignees={assignees} people={people} />
        <Accountability c={c} session={session} people={people} />
        <WhatWasDone c={c} session={session} people={people} />
        <DidItWork c={c} />
        {explanationSlot}
        <StayingFixed c={c} />
        <Section
          id="evidence"
          number={8}
          title="Evidence"
          question="What exists, and can it be trusted?"
        >
          <EvidencePanel
            packages={c.evidencePackages ?? []}
            detail={data.evidence}
            error={data.evidenceError}
            verificationPending={c.didItWork.status === "VERIFICATION_PENDING"}
            restricted={c.evidencePackages === undefined}
          />
          <TrustExplainer />
        </Section>
        <Section id="sharing" number={9} title="Sharing" question="Who can see this evidence?">
          <SharingPanel
            caseId={c.caseId}
            facilityId={c.facilityId}
            sharingState={c.sharing.state}
            agreements={c.sharingAgreements ?? []}
            hasPackage={c.evidence.latestEvidencePackageId !== undefined}
            canManage={session.permissions.includes("SHARING_MANAGE")}
            canGrantRaw={session.permissions.includes("SHARING_GRANT_RAW_TELEMETRY")}
            insurers={insurers}
            orgNames={orgNames}
            people={people}
            returnTo={returnTo}
          />
        </Section>
        <Section
          id="timeline"
          number={10}
          title="Timeline"
          question="What happened, in order?"
          wide
        >
          <Timeline entries={c.evidence.auditReferences} />
        </Section>
      </div>
    </>
  );
}
