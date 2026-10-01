import Link from "next/link";
import { formatPercent, formatTime, shortHash } from "../lib/format";
import {
  SCOPE_INFO,
  STATUS_FOR_RESULT,
  criterionLabel,
  detectionReason,
  hazardLabel,
  outcomeLabel,
  statusForState,
  verificationReason,
} from "../lib/labels";
import type { InsurerCaseData } from "../lib/loaders";
import type { ConsentScope, InsurerCaseDto } from "../lib/types";
import { BeforeAfter } from "./BeforeAfter";
import type { CompareItem } from "./BeforeAfter";
import { InterventionPanel } from "./InterventionPanel";
import { ScopeChips } from "./RiskEvidence";
import { TrustExplainer } from "./TrustExplainer";
import {
  Meter,
  PageHeader,
  Section,
  SeverityBadge,
  StatusBadge,
  SyntheticBadge,
  ToneBadge,
} from "./ui";

const KIND_LABELS: Readonly<Record<string, string>> = {
  BASELINE: "baselines",
  ACTION: "actions",
  AUDIT: "audit entries",
  POLICY: "policy snapshots",
  DEVICE: "device snapshots",
};

/** Shown where the sharing agreement does not cover a section: the absence is explained, not hidden. */
function NotShared({ scope }: { readonly scope: ConsentScope }) {
  return (
    <p className="not-shared" data-not-shared={scope}>
      <ToneBadge tone="neutral" icon="–">
        Not shared with you
      </ToneBadge>{" "}
      <span className="muted">
        The customer has not granted “{SCOPE_INFO[scope].label}”. {SCOPE_INFO[scope].plain}
      </span>
    </p>
  );
}

function compareItems(v: InsurerCaseDto): readonly CompareItem[] {
  const outcomes = new Map((v.verification?.criteria ?? []).map((c) => [c.criterionId, c.outcome]));
  return (v.beforeAfter ?? []).map((b) => ({
    criterionId: b.criterionId,
    role: b.role,
    ...(outcomes.get(b.criterionId) !== undefined && {
      outcome: outcomes.get(b.criterionId) as string,
    }),
    ...(b.signal !== undefined && { signal: b.signal }),
    ...(b.metric !== undefined && { metric: b.metric }),
    ...(b.before !== undefined && { before: b.before }),
    ...(b.after !== undefined && { after: b.after }),
  }));
}

/**
 * The insurer's view of one case: only what the sharing agreement allows. Every section either
 * shows its data or says plainly that it was not shared, so consent filtering is visible. Nothing
 * here comes from the customer's internal APIs, and there are no live sensor values.
 */
export function InsurerCaseDetail({ data }: { readonly data: InsurerCaseData }) {
  const v = data.view;
  const has = (s: ConsentScope) => v.consent.grantedScopes.includes(s);
  const result =
    v.verification === undefined ? undefined : STATUS_FOR_RESULT[v.verification.result];
  const stateStatus =
    v.recommendation === undefined ? undefined : statusForState(v.recommendation.caseState);
  const allScopes = Object.keys(SCOPE_INFO).filter((s) => s !== "RAW_TELEMETRY") as ConsentScope[];
  const notShared = allScopes.filter((s) => !has(s));
  const pkg = v.evidencePackage;
  return (
    <>
      <p className="crumbs">
        <Link href="/risk-evidence">← Risk Evidence</Link> ·{" "}
        <Link href={`/risk-evidence/sites/${encodeURIComponent(v.siteId)}`}>Site {v.siteId}</Link>
      </p>
      <PageHeader
        title={
          v.recommendation !== undefined ? hazardLabel(v.recommendation.hazardType) : "Shared case"
        }
        lead={
          <>
            Case <code>{v.caseId}</code> · site {v.siteId}
          </>
        }
      >
        <div className="header-badges">
          {result !== undefined ? (
            <StatusBadge status={result} size="lg" />
          ) : stateStatus !== undefined ? (
            <StatusBadge status={stateStatus.key} size="lg" />
          ) : null}
          {v.recommendation !== undefined && <SeverityBadge severity={v.recommendation.severity} />}
          {v.source?.synthetic === true && <SyntheticBadge label={v.source.label} />}
        </div>
      </PageHeader>

      <div className="sections">
        <Section
          id="consent"
          number={1}
          title="What the customer shared"
          question="What am I allowed to see?"
          wide
        >
          <p>
            You can see only the scopes the customer granted for this site. Anything else is hidden,
            and raw telemetry is not part of an ordinary grant.
          </p>
          <ScopeChips scopes={v.consent.grantedScopes} />
          {notShared.length > 0 && (
            <p className="muted" data-testid="not-shared-list">
              Not shared: {notShared.map((s) => SCOPE_INFO[s].label).join(", ")}.
            </p>
          )}
          <p className="muted">
            Sharing state: <strong>{v.sharingState.toLowerCase().replace(/_/g, " ")}</strong>.
            Access follows the active agreement and ends the moment the customer revokes it.
          </p>
        </Section>

        <Section id="risk-summary" number={2} title="Risk summary" question="What is the risk?">
          {v.recommendation === undefined ? (
            <NotShared scope="RECOMMENDATION" />
          ) : (
            <dl className="kv">
              <div>
                <dt>Hazard</dt>
                <dd>{hazardLabel(v.recommendation.hazardType)}</dd>
              </div>
              <div>
                <dt>Severity</dt>
                <dd>
                  <SeverityBadge severity={v.recommendation.severity} />
                </dd>
              </div>
              <div>
                <dt>Case state</dt>
                <dd>{stateStatus !== undefined && <StatusBadge status={stateStatus.key} />}</dd>
              </div>
            </dl>
          )}
          {v.eventSummary === undefined ? (
            <NotShared scope="EVENT_SUMMARY" />
          ) : (
            <>
              <p>Detected {formatTime(v.eventSummary.detectedAt)}.</p>
              <ul className="plain-list">
                {v.eventSummary.detectionReasonCodes.map((c) => (
                  <li key={c}>{detectionReason(c)}</li>
                ))}
              </ul>
            </>
          )}
        </Section>

        <Section
          id="reported-actions"
          number={3}
          title="Customer-reported actions"
          question="What did the customer say they did?"
        >
          {v.actionSummary === undefined ? (
            <NotShared scope="ACTION_SUMMARY" />
          ) : (
            <>
              <p className="note">{v.actionSummary.note}</p>
              {v.actionSummary.actions.length === 0 ? (
                <p className="muted">No action reported.</p>
              ) : (
                <ul className="actions">
                  {v.actionSummary.actions.map((a) => (
                    <li key={a.actionLibraryId}>
                      <div className="action-head">
                        <strong>{a.title ?? a.actionLibraryId}</strong>
                        <ToneBadge tone="info" icon="◔">
                          {a.status === "REPORTED_COMPLETE"
                            ? "Reported complete (customer-reported)"
                            : a.status.toLowerCase()}
                        </ToneBadge>
                      </div>
                      <p className="muted">
                        {a.assignedAt !== undefined && <>Assigned {formatTime(a.assignedAt)}</>}
                        {a.reportedAt !== undefined && <> · reported {formatTime(a.reportedAt)}</>}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>

        <Section
          id="verification"
          number={4}
          title="Verification outcome"
          question="Did sensors confirm the improvement?"
          wide
        >
          {v.verification === undefined ? (
            <NotShared scope="VERIFICATION_RESULT" />
          ) : (
            <>
              <div className="verdict" data-did-it-work={v.verification.result}>
                {result !== undefined && (
                  <StatusBadge status={result} label={v.verification.resultLabel} size="lg" />
                )}
                <p>{v.verification.interpretation}</p>
              </div>
              <dl className="kv">
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {v.verification.policyId} v{v.verification.policyVersion}
                  </dd>
                </div>
                <div>
                  <dt>Evaluated</dt>
                  <dd>{formatTime(v.verification.evaluatedAt)}</dd>
                </div>
                <div>
                  <dt>Post-action window</dt>
                  <dd>
                    {formatTime(v.verification.postActionWindow.start)} to{" "}
                    {formatTime(v.verification.postActionWindow.end)}
                  </dd>
                </div>
              </dl>
              <h3>Why this result</h3>
              <ul className="plain-list">
                {v.verification.reasonCodes.map((c) => (
                  <li key={c}>{verificationReason(c)}</li>
                ))}
              </ul>
              <table className="mini-table">
                <thead>
                  <tr>
                    <th scope="col">Criterion</th>
                    <th scope="col">Role</th>
                    <th scope="col">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {v.verification.criteria.map((x) => (
                    <tr key={x.criterionId}>
                      <th scope="row">{criterionLabel(x.criterionId)}</th>
                      <td>{x.role === "SUPPORTING" ? "Supporting" : "Required"}</td>
                      <td>{outcomeLabel(x.outcome)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Section>

        <Section
          id="before-after"
          number={5}
          title="Before and after"
          question="What changed physically?"
          wide
        >
          {v.beforeAfter === undefined ? (
            <NotShared scope="BEFORE_AFTER_METRICS" />
          ) : (
            <BeforeAfter items={compareItems(v)} />
          )}
        </Section>

        <Section
          id="confidence"
          number={6}
          title="Confidence and completeness"
          question="How much weight can it carry?"
        >
          {v.confidence === undefined ? (
            <NotShared scope="VERIFICATION_CONFIDENCE" />
          ) : (
            <>
              <div className="meters">
                <Meter value={v.confidence.confidence} label="Confidence" />
                <Meter value={v.confidence.dataCompleteness} label="Data completeness" />
                <Meter value={v.confidence.telemetryConfidence} label="Telemetry confidence" />
              </div>
              <p className="muted">
                Device health: {v.confidence.deviceHealthStatus.toLowerCase()} · authenticity:{" "}
                {v.confidence.authIntegrityStatus.toLowerCase()} · overall{" "}
                {formatPercent(v.confidence.confidence)}
              </p>
            </>
          )}
        </Section>

        <Section id="recurrence" number={7} title="Recurrence" question="Is it staying fixed?">
          {v.recurrence === undefined ? (
            <NotShared scope="RECURRENCE_STATUS" />
          ) : (
            <dl className="kv">
              <div>
                <dt>Recurrences now</dt>
                <dd data-testid="recurrence-count">{v.recurrence.currentRecurrenceCount}</dd>
              </div>
              <div>
                <dt>At the time of the package</dt>
                <dd>{v.recurrence.recurrenceCountAtPackage}</dd>
              </div>
              <div>
                <dt>Returned since the package</dt>
                <dd>{v.recurrence.reopenedSincePackage ? "Yes. The case was reopened." : "No"}</dd>
              </div>
              <div>
                <dt>Watch period ends</dt>
                <dd>
                  {v.recurrence.recurrenceWatchEndsAt !== null
                    ? formatTime(v.recurrence.recurrenceWatchEndsAt)
                    : "—"}
                </dd>
              </div>
            </dl>
          )}
        </Section>

        <Section
          id="intervention"
          number={8}
          title="Risk-engineer recommendation"
          question="Does anyone need to look closer?"
        >
          {data.intervention === undefined ? (
            has("INTERVENTION_RECOMMENDATION") ? (
              <p className="muted">No current recommendation for this case.</p>
            ) : (
              <NotShared scope="INTERVENTION_RECOMMENDATION" />
            )
          ) : (
            <InterventionPanel
              intervention={data.intervention}
              supportingEvidenceCount={
                pkg === undefined ? undefined : pkg.artifacts.length + pkg.observationArtifactCount
              }
            />
          )}
        </Section>

        <Section
          id="evidence"
          number={9}
          title="Evidence package"
          question="What exists, and is it intact?"
          wide
        >
          {pkg === undefined ? (
            v.evidenceAvailable === false ? (
              <p className="muted" data-testid="no-evidence">
                No evidence package exists for this case yet.
              </p>
            ) : (
              <NotShared scope="EVIDENCE_ARTIFACTS" />
            )
          ) : (
            <div data-testid="evidence-panel">
              <dl className="kv">
                <div>
                  <dt>Package</dt>
                  <dd>
                    <code>{pkg.packageId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Generated</dt>
                  <dd>{formatTime(pkg.createdAt)}</dd>
                </div>
                <div>
                  <dt>Integrity</dt>
                  <dd>
                    <ToneBadge tone="good" icon="✓">
                      Hash verified before release ({pkg.hashAlgorithm})
                    </ToneBadge>
                  </dd>
                </div>
                <div>
                  <dt>Policy</dt>
                  <dd>
                    {pkg.versions.verificationPolicy.id} v{pkg.versions.verificationPolicy.version}
                  </dd>
                </div>
                <div>
                  <dt>Data origin</dt>
                  <dd>{v.source !== undefined ? v.source.label : "—"}</dd>
                </div>
                <div>
                  <dt>Contents</dt>
                  <dd>
                    {pkg.artifacts.length + pkg.observationArtifactCount} records:{" "}
                    {Object.entries(
                      pkg.artifacts.reduce<Record<string, number>>((m, a) => {
                        m[a.kind] = (m[a.kind] ?? 0) + 1;
                        return m;
                      }, {}),
                    )
                      .map(([k, n]) => `${n} ${KIND_LABELS[k] ?? k.toLowerCase()}`)
                      .join(", ")}
                    {pkg.observationArtifactCount > 0 && (
                      <>
                        , {pkg.observationArtifactCount} sensor observations (counted, not shared)
                      </>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Hashes</dt>
                  <dd>
                    <span className="hash" title={pkg.payloadSha256}>
                      payload {shortHash(pkg.payloadSha256)}
                    </span>
                    <span className="hash" title={pkg.manifestSha256}>
                      manifest {shortHash(pkg.manifestSha256)}
                    </span>
                  </dd>
                </div>
              </dl>
            </div>
          )}
          <TrustExplainer />
        </Section>
      </div>
    </>
  );
}
