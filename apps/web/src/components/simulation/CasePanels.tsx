"use client";

import { fieldValue } from "../../lib/dom";
import { useEffect, useState } from "react";
import { formatClock } from "../../lib/sim-format";
import { problemText, simGet, simPost } from "../../lib/sim-client";
import type { SimOverview, SimSeries } from "../../lib/sim-types";
import type { CaseDto, ConsentScope, EvidenceDetailDto } from "../../lib/types";
import { LineChart } from "./Charts";
import type { Band, Marker } from "./Charts";
import { Pill } from "./Panels";

const CASE_STATE_LABELS: Readonly<
  Record<
    string,
    { label: string; tone: "good" | "warn" | "danger" | "info" | "neutral"; icon: string }
  >
> = {
  OPEN: { label: "Risk detected", tone: "danger", icon: "●" },
  ACTION_REQUIRED: { label: "Action required", tone: "warn", icon: "▲" },
  ACTION_REPORTED: { label: "Action reported · verification pending", tone: "info", icon: "◔" },
  VERIFYING: { label: "Verification in progress", tone: "info", icon: "◔" },
  VERIFIED_IMPROVED: { label: "Verified improved", tone: "good", icon: "✓" },
  PARTIALLY_VERIFIED: { label: "Partially verified", tone: "warn", icon: "▲" },
  NOT_IMPROVING: { label: "Not improving", tone: "danger", icon: "✕" },
  INCONCLUSIVE: { label: "Inconclusive", tone: "warn", icon: "?" },
  REOPENED: { label: "Reopened · recurring", tone: "danger", icon: "⟲" },
  CLOSED: { label: "Closed", tone: "neutral", icon: "–" },
};

const OUTCOME_STYLE: Readonly<
  Record<string, { tone: "good" | "danger" | "warn"; icon: string; label: string }>
> = {
  PASS: { tone: "good", icon: "✓", label: "PASS" },
  FAIL: { tone: "danger", icon: "✕", label: "FAIL" },
  INSUFFICIENT: { tone: "warn", icon: "?", label: "INSUFFICIENT" },
};

const CRITERION_NAMES: Readonly<Record<string, string>> = {
  VIBRATION: "Vibration back near baseline",
  CURRENT: "Current back near baseline",
  BACKUP_CAPACITY: "Backup cooling observed running",
  ZONE_TEMPERATURE_SLOPE: "Zone temperature stable or falling",
  DATA_QUALITY: "Data quality (enough fresh, trusted samples)",
  DEVICE_INTEGRITY: "Device integrity (healthy, authenticated)",
};

// ---- case workflow ---------------------------------------------------------------------------------------------

export function CaseWorkflow({
  overview,
  caseDto,
  actorId,
  onChanged,
}: {
  readonly overview: SimOverview;
  readonly caseDto: CaseDto | undefined;
  readonly actorId: string;
  readonly onChanged: () => void;
}) {
  const [actionId, setActionId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  if (caseDto === undefined) {
    return (
      <div data-testid="case-empty">
        <p className="empty-line">
          No case is open.{" "}
          {overview.rule.outcome === "NORMAL"
            ? "Everything reads normal."
            : "A case opens only when the compound condition persists."}
        </p>
      </div>
    );
  }
  const st = CASE_STATE_LABELS[caseDto.state] ?? {
    label: caseDto.state,
    tone: "neutral" as const,
    icon: "•",
  };
  const acc = caseDto.accountability;
  const reported = caseDto.whatWasDone.actions.filter((a) => a.status === "REPORTED_COMPLETE");
  const steps = [
    {
      id: "detected",
      label: "Risk detected",
      done: true,
      note: `${caseDto.detectionCount} detection${caseDto.detectionCount === 1 ? "" : "s"}`,
    },
    {
      id: "alerted",
      label: "Alert sent",
      done: acc.alert.status === "SENT",
      failed: acc.alert.deliveryFailed,
      note:
        acc.alert.status === "SENT"
          ? `to ${acc.alert.recipient ?? ""}`
          : acc.alert.deliveryFailed
            ? "delivery failed"
            : acc.alert.status.toLowerCase(),
    },
    {
      id: "ack",
      label: "Acknowledged",
      done: acc.acknowledgement.acknowledged,
      note: acc.acknowledgement.by ?? "waiting",
    },
    {
      id: "action",
      label: "Action reported",
      done: reported.length > 0,
      note: reported.length > 0 ? `${reported.length} reported` : "waiting",
    },
    {
      id: "verify",
      label: "Sensors verify",
      done:
        ["VERIFIED_IMPROVED", "PARTIALLY_VERIFIED", "NOT_IMPROVING", "INCONCLUSIVE"].includes(
          caseDto.state,
        ) || caseDto.state === "REOPENED",
      note: caseDto.didItWork.label,
    },
  ];
  const approved = caseDto.whatToDo.approvedActions;
  const chosen =
    actionId !== ""
      ? actionId
      : (approved.find((a) => a.status === "AVAILABLE")?.actionLibraryId ??
        approved[0]?.actionLibraryId ??
        "");

  async function acknowledge() {
    setBusy(true);
    setMessage(null);
    const r = await simPost<unknown>(
      `cases/${encodeURIComponent(caseDto?.caseId ?? "")}/acknowledge`,
      {},
    );
    setBusy(false);
    setMessage(
      r.ok
        ? { kind: "ok", text: "Acknowledged. Your name is on the audit trail." }
        : { kind: "error", text: problemText(r.problem) },
    );
    if (r.ok) onChanged();
  }

  async function takeAction() {
    setBusy(true);
    setMessage(null);
    const id = encodeURIComponent(caseDto?.caseId ?? "");
    const assign = await simPost<{ actionId: string }>(`cases/${id}/assignments`, {
      actionLibraryId: chosen,
      assigneeId: actorId,
    });
    if (!assign.ok) {
      setBusy(false);
      setMessage({ kind: "error", text: problemText(assign.problem) });
      return;
    }
    const report = await simPost<unknown>(`cases/${id}/actions`, {
      actionLibraryId: chosen,
      actionId: assign.value.actionId,
      ...(notes.trim() !== "" && { notes: notes.trim().slice(0, 500) }),
    });
    setBusy(false);
    if (report.ok) {
      setNotes("");
      setMessage({
        kind: "ok",
        text: "Action reported complete. That is not the same as improved: the sensors decide, after the post-action window.",
      });
      onChanged();
    } else setMessage({ kind: "error", text: problemText(report.problem) });
  }

  return (
    <div data-testid="case-panel" data-case-state={caseDto.state}>
      <div className="rule-head">
        <strong>{caseDto.title}</strong>
        <Pill tone={st.tone} icon={st.icon} testId="case-state">
          {st.label}
        </Pill>
        <Pill
          tone={
            caseDto.severity === "LOW"
              ? "neutral"
              : caseDto.severity === "MODERATE"
                ? "warn"
                : "danger"
          }
        >
          Severity {caseDto.severity.toLowerCase()}
        </Pill>
        {caseDto.stayingFixed.recurrenceCount > 0 && (
          <Pill tone="danger" icon="⟲" testId="case-recurrences">
            Recurred {caseDto.stayingFixed.recurrenceCount}×
          </Pill>
        )}
        <a
          className="btn btn-quiet btn-small"
          href={`/operations/cases/${encodeURIComponent(caseDto.caseId)}`}
        >
          Open the full case
        </a>
      </div>
      <p className="muted">{caseDto.whatHappened.summary}</p>
      <ol className="stepper" aria-label="Case lifecycle">
        {steps.map((s) => (
          <li
            key={s.id}
            className={
              s.done ? "step done" : "failed" in s && s.failed === true ? "step failed" : "step"
            }
            data-step={s.id}
          >
            <span className="step-dot" aria-hidden="true">
              {s.done ? "✓" : "failed" in s && s.failed === true ? "✕" : "○"}
            </span>
            <span>
              <strong>{s.label}</strong>
              <span className="muted block">{s.note}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="split-facts" data-testid="reported-vs-verified">
        <div className="fact-card">
          <h4>Reported by people</h4>
          {reported.length === 0 ? (
            <p className="muted">Nothing reported yet.</p>
          ) : (
            <ul>
              {reported.map((a) => (
                <li key={a.actionId}>
                  <Pill tone="info" icon="✓">
                    REPORTED COMPLETE
                  </Pill>{" "}
                  {a.title}
                  {a.reportedAt !== undefined && (
                    <span className="muted"> · {formatClock(a.reportedAt)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="muted">A report is evidence that something was done.</p>
        </div>
        <div className="neq" aria-hidden="true">
          ≠
        </div>
        <div className="fact-card">
          <h4>Verified by sensors</h4>
          <p>
            <Pill
              tone={
                caseDto.didItWork.status === "VERIFIED_IMPROVED"
                  ? "good"
                  : caseDto.didItWork.status === "NOT_IMPROVING"
                    ? "danger"
                    : caseDto.didItWork.status === "VERIFICATION_PENDING"
                      ? "info"
                      : "warn"
              }
              icon={
                caseDto.didItWork.status === "VERIFIED_IMPROVED"
                  ? "✓"
                  : caseDto.didItWork.status === "NOT_IMPROVING"
                    ? "✕"
                    : "◔"
              }
              testId="did-it-work"
            >
              {caseDto.didItWork.label}
            </Pill>
          </p>
          <p className="muted">{caseDto.didItWork.detail}</p>
        </div>
      </div>

      {caseDto.nextSteps.canAcknowledge && (
        <div className="control-actions">
          <button
            type="button"
            className="btn"
            data-testid="ack-button"
            disabled={busy}
            onClick={() => void acknowledge()}
          >
            Acknowledge this risk
          </button>
          <span className="muted">Acknowledging is not a fix; it records who is accountable.</span>
        </div>
      )}
      {caseDto.nextSteps.canAssignOrReport && approved.length > 0 && (
        <form
          className="control-form"
          aria-label="Take an approved action"
          onSubmit={(e) => {
            e.preventDefault();
            void takeAction();
          }}
        >
          <h3>Take an approved action</h3>
          <p className="muted">
            Symbiosis recommends only; it never operates equipment. You report what a person did.
          </p>
          <div className="control-row">
            <label htmlFor="sim-action">Approved action</label>
            <select
              id="sim-action"
              data-testid="action-select"
              value={chosen}
              onChange={(e) => setActionId(fieldValue(e))}
            >
              {approved.map((a) => (
                <option key={a.actionLibraryId} value={a.actionLibraryId}>
                  {a.title}
                  {a.status !== "AVAILABLE" ? ` (${a.status.toLowerCase()})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="control-row">
            <label htmlFor="sim-notes">Notes (optional)</label>
            <textarea
              id="sim-notes"
              data-testid="action-notes"
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(e) => setNotes(fieldValue(e))}
            />
          </div>
          <div className="control-actions">
            <button
              type="submit"
              className="btn"
              data-testid="report-button"
              disabled={busy || chosen === ""}
            >
              Assign to me and report it complete
            </button>
          </div>
        </form>
      )}
      {message !== null && (
        <p
          className={message.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={message.kind === "ok" ? "status" : "alert"}
          data-testid="case-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

// ---- verification -----------------------------------------------------------------------------------------------

export function VerificationPanel({
  caseDto,
  series,
}: {
  readonly caseDto: CaseDto | undefined;
  readonly series: SimSeries | undefined;
}) {
  const v = caseDto?.verification;
  const reportedTimes = (caseDto?.whatWasDone.actions ?? [])
    .filter((a) => a.reportedAt !== undefined)
    .map((a) => Date.parse(a.reportedAt as string));
  const markers: Marker[] = reportedTimes.map((t) => ({
    t,
    label: "action reported",
    tone: "warn" as const,
  }));
  const bands: Band[] =
    v === undefined
      ? []
      : [
          {
            from: Date.parse(v.postActionWindow.start),
            to: Date.parse(v.postActionWindow.end),
            label: "verification window",
          },
        ];
  return (
    <div data-testid="verification-panel">
      {v === undefined ? (
        <p className="empty-line" data-testid="verification-empty">
          {caseDto?.state === "ACTION_REPORTED" || caseDto?.state === "VERIFYING"
            ? "VERIFICATION PENDING: the sensors are being watched through the post-action window."
            : "No verification yet. It starts after a person reports an action."}
        </p>
      ) : (
        <>
          <div className="rule-head">
            <Pill
              tone={
                v.result === "VERIFIED"
                  ? "good"
                  : v.result === undefined
                    ? "info"
                    : v.result === "NOT_IMPROVING"
                      ? "danger"
                      : "warn"
              }
              icon={v.result === "VERIFIED" ? "✓" : v.result === undefined ? "◔" : "✕"}
              testId="verification-result"
            >
              {v.resultLabel ?? "Verification pending"}
            </Pill>
            <span className="muted">
              Policy {v.policyId} version <strong>{v.policyVersion}</strong>
            </span>
            {v.evaluatedAt !== undefined && (
              <span className="muted">· evaluated {formatClock(v.evaluatedAt)}</span>
            )}
          </div>
          {v.result !== undefined && (
            <dl className="facts facts-row">
              <dt>Evidence completeness</dt>
              <dd data-testid="verification-completeness">
                {Math.round((v.dataCompleteness ?? 0) * 100)}%
              </dd>
              <dt>Telemetry confidence</dt>
              <dd>{Math.round((v.telemetryConfidence ?? 0) * 100)}%</dd>
              <dt>Overall confidence</dt>
              <dd data-testid="verification-confidence">
                {Math.round((v.confidence ?? 0) * 100)}%
              </dd>
              <dt>Device / authentication</dt>
              <dd>
                {v.deviceHealthStatus ?? "—"} / {v.authIntegrityStatus ?? "—"}
              </dd>
            </dl>
          )}
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
            <table className="table" data-testid="criteria-table">
              <caption className="visually-hidden">Verification criteria</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Role</th>
                  <th scope="col">Result</th>
                  <th scope="col">Before the action</th>
                  <th scope="col">After the action</th>
                </tr>
              </thead>
              <tbody>
                {v.criteria.map((c) => {
                  const o = OUTCOME_STYLE[c.outcome] ?? {
                    tone: "warn" as const,
                    icon: "?",
                    label: c.outcome,
                  };
                  const stat = (
                    s:
                      | { sampleCount: number; mean?: number; min?: number; max?: number }
                      | undefined,
                  ) =>
                    s === undefined
                      ? "—"
                      : `${s.mean === undefined ? "" : `mean ${s.mean.toFixed(3)} `}(${s.sampleCount} samples)`;
                  return (
                    <tr
                      key={c.criterionId}
                      data-testid={`criterion-${c.criterionId}`}
                      data-outcome={c.outcome}
                    >
                      <th scope="row">
                        {CRITERION_NAMES[c.criterionId] ?? c.criterionId}
                        {c.reasonCodes.length > 0 && (
                          <span className="muted block">
                            {c.reasonCodes.slice(0, 2).join(", ")}
                          </span>
                        )}
                      </th>
                      <td>{c.role === "REQUIRED" ? "Required" : "Supporting"}</td>
                      <td>
                        <Pill tone={o.tone} icon={o.icon}>
                          {o.label}
                        </Pill>
                      </td>
                      <td>{stat(c.before)}</td>
                      <td>{stat(c.observed)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {series !== undefined && (
        <div className="chart-grid" data-testid="charts">
          <LineChart
            title="Vibration"
            unit={series.series.vibration.unit}
            points={series.series.vibration.points}
            baseline={series.series.vibration.baseline}
            fromMs={series.fromMs}
            toMs={series.toMs}
            markers={markers}
            bands={bands}
          />
          <LineChart
            title="Equipment current"
            unit={series.series.current.unit}
            points={series.series.current.points}
            baseline={series.series.current.baseline}
            fromMs={series.fromMs}
            toMs={series.toMs}
            markers={markers}
            bands={bands}
          />
          <LineChart
            title="Zone temperature"
            unit={series.series.zoneTemperature.unit}
            points={series.series.zoneTemperature.points}
            baseline={series.series.zoneTemperature.baseline}
            fromMs={series.fromMs}
            toMs={series.toMs}
            markers={markers}
            bands={bands}
          />
          <LineChart
            title="Backup unit running (1 = running)"
            unit="state"
            points={series.series.backupRunning.points}
            fromMs={series.fromMs}
            toMs={series.toMs}
            markers={markers}
            bands={bands}
            step
          />
        </div>
      )}
    </div>
  );
}

// ---- evidence and sharing --------------------------------------------------------------------------------------------

const STANDARD_SCOPES: readonly ConsentScope[] = [
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

export function EvidencePanel({
  overview,
  caseDto,
  onChanged,
}: {
  readonly overview: SimOverview;
  readonly caseDto: CaseDto | undefined;
  readonly onChanged: () => void;
}) {
  const [detail, setDetail] = useState<EvidenceDetailDto | undefined>();
  const [recipient, setRecipient] = useState("ORG-INS-001");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = caseDto?.evidence.latestEvidencePackageId;

  useEffect(() => {
    let cancelled = false;
    if (latest === undefined) {
      setDetail(undefined);
      return;
    }
    void simGet<EvidenceDetailDto>(`evidence/${encodeURIComponent(latest)}`).then((r) => {
      if (!cancelled) setDetail(r.ok ? r.value : undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [latest]);

  if (caseDto === undefined) {
    return <p className="empty-line">Evidence appears after a verification completes.</p>;
  }
  const packages = caseDto.evidencePackages ?? [];
  async function grant() {
    setBusy(true);
    setMessage(null);
    const r = await simPost<unknown>("sharing-agreements", {
      recipientOrganizationId: recipient.trim(),
      facilityIds: [overview.facility.facilityId],
      scopes: STANDARD_SCOPES,
    });
    setBusy(false);
    setMessage(
      r.ok
        ? {
            kind: "ok",
            text: "Sharing granted. The insurer can now see only the consented evidence.",
          }
        : { kind: "error", text: problemText(r.problem) },
    );
    if (r.ok) onChanged();
  }
  async function revoke(id: string) {
    setBusy(true);
    setMessage(null);
    const r = await simPost<unknown>(`sharing-agreements/${encodeURIComponent(id)}/revoke`, {
      reason: "Revoked from the simulation workspace",
    });
    setBusy(false);
    setMessage(
      r.ok
        ? { kind: "ok", text: "Revoked. The insurer is denied on its very next request." }
        : { kind: "error", text: problemText(r.problem) },
    );
    if (r.ok) onChanged();
  }
  const active = (caseDto.sharingAgreements ?? []).filter((a) => a.status === "ACTIVE");
  return (
    <div data-testid="evidence-panel">
      <div className="rule-head">
        <Pill
          tone={caseDto.sharing.state === "SHARED" ? "info" : "neutral"}
          icon="⇄"
          testId="sharing-state"
        >
          {caseDto.sharing.label}
        </Pill>
        {detail !== undefined && (
          <Pill
            tone={detail.package.payload.source.synthetic ? "synthetic" : "info"}
            icon="◇"
            testId="evidence-source"
          >
            {detail.package.payload.source.synthetic
              ? "Simulation data"
              : "Customer integration data"}
          </Pill>
        )}
      </div>
      {packages.length === 0 ? (
        <p className="empty-line" data-testid="evidence-empty">
          No evidence package yet. One is created for every completed verification, whatever its
          result.
        </p>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Scrollable table">
          <table className="table">
            <caption className="visually-hidden">Evidence packages</caption>
            <thead>
              <tr>
                <th scope="col">Package</th>
                <th scope="col">Result recorded</th>
                <th scope="col">Created</th>
                <th scope="col">Manifest SHA-256</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.packageId} data-testid="evidence-row">
                  <th scope="row">{p.packageId}</th>
                  <td>{p.result.replace(/_/g, " ")}</td>
                  <td>{formatClock(p.createdAt)}</td>
                  <td>
                    <code>{p.manifestSha256.slice(0, 16)}…</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail !== undefined && (
        <p className="muted" data-testid="evidence-label">
          {detail.package.payload.source.label} Integrity:{" "}
          {detail.integrity.valid ? "hashes verify" : "HASH MISMATCH"}. Policy{" "}
          {detail.package.payload.verification.policyId} version{" "}
          {detail.package.payload.verification.policyVersion}.
        </p>
      )}
      <h3>Customer-controlled sharing</h3>
      <p className="muted">
        Nothing is shared by default. Granting gives the insurer only the evidence scopes below;
        revoking removes access immediately. Switch to an insurer identity and open Risk Evidence to
        see exactly what they see.
      </p>
      {overview.permissions.control && (
        <form
          className="control-form"
          onSubmit={(e) => {
            e.preventDefault();
            void grant();
          }}
        >
          <div className="control-row">
            <label htmlFor="sim-recipient">Insurer organization</label>
            <input
              id="sim-recipient"
              data-testid="share-recipient"
              value={recipient}
              maxLength={64}
              onChange={(e) => setRecipient(fieldValue(e))}
            />
          </div>
          <div className="control-actions">
            <button
              type="submit"
              className="btn"
              data-testid="share-grant"
              disabled={busy || packages.length === 0}
            >
              Share evidence with the insurer
            </button>
            {active.map((a) => (
              <button
                key={a.agreement.agreementId}
                type="button"
                className="btn btn-quiet"
                data-testid="share-revoke"
                disabled={busy}
                onClick={() => void revoke(a.agreement.agreementId)}
              >
                Revoke {a.agreement.agreementId}
              </button>
            ))}
          </div>
        </form>
      )}
      {message !== null && (
        <p
          className={message.kind === "ok" ? "notice notice-ok" : "notice notice-error"}
          role={message.kind === "ok" ? "status" : "alert"}
          data-testid="share-message"
        >
          {message.text}
        </p>
      )}
    </div>
  );
}
