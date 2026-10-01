import type { CaseView, CaseViewSummary } from "@symbiosis/action-orchestration";
import type { InsuranceSiteView, InsurerCaseView, InsurerEvidenceView } from "@symbiosis/consent";

/**
 * MINIMAL WORKFLOW-PROOF PAGES (S4, extended in S5). They show: detected -> alert ->
 * acknowledgement -> action report -> verification pending -> result, recurrence status and the
 * intervention recommendation. Server-rendered, read-only HTML with no scripts; NOT the final UI
 * (S7 builds the workspaces and Trust Center). Result wording comes only from the case view
 * model, which derives it from persisted verification records, so this file never contains a
 * result label of its own.
 */
const esc = (v: unknown) =>
  String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:1.5rem auto;max-width:56rem;padding:0 1rem;color:#1b1f23}
h1{font-size:1.4rem}h2{font-size:1.05rem;margin-top:1.6rem;border-bottom:1px solid #d0d7de;padding-bottom:.2rem}
.banner{background:#fff8c5;border:1px solid #d4a72c;padding:.5rem .75rem;border-radius:6px}
.pending{background:#ddf4ff;border:1px solid #54aeff;padding:.6rem .8rem;border-radius:6px;font-weight:600}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:.3rem .5rem;text-align:left;vertical-align:top}
code{background:#f6f8fa;padding:0 .25rem;border-radius:4px}.muted{color:#57606a}</style></head>
<body><p class="banner">Local workflow-proof page (development identity). Not the final UI.</p>${body}</body></html>`;

export function renderErrorHtml(status: number, message: string): string {
  return page(`Error ${status}`, `<h1>Error ${esc(status)}</h1><p>${esc(message)}</p>`);
}

export function renderCaseListHtml(rows: readonly CaseViewSummary[], actorId: string): string {
  const items = rows
    .map(
      (r) =>
        `<tr><td><a href="/ui/cases/${esc(r.caseId)}?actor=${esc(actorId)}">${esc(r.caseId)}</a></td>` +
        `<td>${esc(r.title)}</td><td>${esc(r.severity)}</td><td>${esc(r.state)}</td>` +
        `<td>${esc(r.riskEventState ?? "-")}</td><td>${esc(r.didItWork)}</td></tr>`,
    )
    .join("");
  return page(
    "Risk Improvement Cases",
    `<h1>Risk Improvement Cases</h1><p class="muted">Signed in (development) as <code>${esc(actorId)}</code></p>` +
      (rows.length === 0
        ? "<p>No cases.</p>"
        : `<table><tr><th>Case</th><th>Title</th><th>Severity</th><th>Case state</th><th>Risk event</th><th>Did it work?</th></tr>${items}</table>`),
  );
}

/** Evidence and sharing facts for the case page, assembled by the handler from the services. */
export type CaseEvidenceExtras = {
  readonly packages: readonly {
    readonly packageId: string;
    readonly createdAt: string;
    readonly resultLabel: string;
  }[];
  readonly latest?: {
    readonly packageId: string;
    readonly resultLabel: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly createdAt: string;
    readonly payloadSha256: string;
    readonly manifestSha256: string;
    readonly integrityValid: boolean;
    readonly integrityIssues: readonly string[];
    readonly sourceLabel: string;
    readonly synthetic: boolean;
  };
  readonly agreements: readonly {
    readonly agreementId: string;
    readonly recipientOrganizationId: string;
    readonly scopes: readonly string[];
    readonly status: string;
    readonly effectiveFrom: string;
    readonly expiresAt?: string;
    readonly revokedAt?: string;
  }[];
  readonly canManageSharing: boolean;
  readonly canGrantRaw: boolean;
  readonly standardScopes: readonly string[];
};

function evidenceAndSharingHtml(v: CaseView, actorId: string, x: CaseEvidenceExtras): string {
  const a = encodeURIComponent(actorId);
  const latest = x.latest;
  const evidence =
    latest === undefined
      ? "<p>No evidence package exists for this case yet.</p>"
      : `<table>
<tr><th>Package</th><td><code>${esc(latest.packageId)}</code></td><th>Created</th><td>${esc(latest.createdAt)}</td></tr>
<tr><th>Verification result</th><td><strong>${esc(latest.resultLabel)}</strong></td><th>Policy</th><td>${esc(latest.policyId)} v${esc(latest.policyVersion)}</td></tr>
<tr><th>Payload SHA-256</th><td colspan="3"><code>${esc(latest.payloadSha256)}</code></td></tr>
<tr><th>Manifest SHA-256</th><td colspan="3"><code>${esc(latest.manifestSha256)}</code></td></tr>
<tr><th>Hash verification</th><td colspan="3"><strong>${latest.integrityValid ? "VALID (recomputed now)" : `INVALID: ${esc(latest.integrityIssues.join(", "))}`}</strong></td></tr>
<tr><th>Data source</th><td colspan="3"><span class="banner">${esc(latest.sourceLabel)}</span></td></tr>
</table><p class="muted">A package records what the verification concluded. It does not by itself show improvement, and it is not shared until a sharing agreement exists.</p>`;
  const history =
    x.packages.length > 1
      ? `<p class="muted">Package history:</p><ul>${x.packages.map((p) => `<li><code>${esc(p.packageId)}</code> ${esc(p.resultLabel)} <span class="muted">${esc(p.createdAt)}</span></li>`).join("")}</ul>`
      : "";
  const rows = x.agreements
    .map(
      (g) =>
        `<tr><td><code>${esc(g.agreementId)}</code></td><td>${esc(g.recipientOrganizationId)}</td><td>${esc(g.scopes.join(", "))}</td>` +
        `<td><strong>${esc(g.status)}</strong>${g.revokedAt ? ` at ${esc(g.revokedAt)}` : ""}</td><td>${esc(g.effectiveFrom)}${g.expiresAt ? ` to ${esc(g.expiresAt)}` : ""}</td><td>${
          g.status === "REVOKED" || !x.canManageSharing
            ? ""
            : `<form method="post" action="/ui/sharing/${esc(g.agreementId)}/revoke?actor=${a}&amp;case=${esc(v.caseId)}"><button type="submit">Revoke</button></form>`
        }</td></tr>`,
    )
    .join("");
  const form = !x.canManageSharing
    ? ""
    : `<h3>Grant sharing</h3>
<form method="post" action="/ui/sharing/grant?actor=${a}&amp;case=${esc(v.caseId)}">
<p>Recipient organization: <input name="recipientOrganizationId" value="ORG-INS-001" required></p>
<p>Facility: <code>${esc(v.facilityId)}</code><input type="hidden" name="facilityId" value="${esc(v.facilityId)}"></p>
<p>Scopes the recipient may see:</p>
${x.standardScopes.map((sc) => `<label><input type="checkbox" name="scope" value="${esc(sc)}" checked> ${esc(sc)}</label><br>`).join("")}
${x.canGrantRaw ? `<label><input type="checkbox" name="scope" value="RAW_TELEMETRY"> RAW_TELEMETRY (off by default; separate explicit scope)</label><br>` : `<span class="muted">RAW_TELEMETRY is off and needs an organization administrator.</span><br>`}
<p>Expires at (optional ISO time): <input name="expiresAt" placeholder="2026-12-31T00:00:00Z"></p>
<button type="submit">Grant sharing</button></form>`;
  return `
<h2>Evidence</h2>
${evidence}${history}

<h2>Sharing</h2>
<p><strong>${esc(v.sharing.state)}</strong>: ${esc(v.sharing.label)}</p>
${x.agreements.length === 0 ? "<p>No sharing agreements cover this facility.</p>" : `<table><tr><th>Agreement</th><th>Recipient</th><th>Scopes</th><th>Status</th><th>Window</th><th></th></tr>${rows}</table>`}
${form}`;
}

export function renderCaseHtml(v: CaseView, actorId: string, extras?: CaseEvidenceExtras): string {
  const a = v.accountability;
  const list = (items: readonly string[]) =>
    items.length === 0 ? "<p>-</p>" : `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
  const actions = v.whatToDo.approvedActions
    .map(
      (x) =>
        `<tr><td><code>${esc(x.actionLibraryId)}</code></td><td>${esc(x.title)}<br><span class="muted">${esc(x.description)}</span></td><td>${esc(x.status)}</td></tr>`,
    )
    .join("");
  const done = v.whatWasDone.actions
    .map(
      (x) =>
        `<tr><td><code>${esc(x.actionId)}</code></td><td>${esc(x.title)}</td><td>${esc(x.status)}</td>` +
        `<td>${esc(x.reportedBy ?? x.assignedTo ?? "-")}</td><td>${esc(x.reportedAt ?? "-")}</td><td>${esc(x.notes ?? "")}</td></tr>`,
    )
    .join("");
  const refs = v.evidence.auditReferences
    .map(
      (r) =>
        `<li><code>${esc(r.auditId)}</code> ${esc(r.action)} <span class="muted">${esc(r.at)}</span></li>`,
    )
    .join("");
  const stat = (s?: { sampleCount: number; mean?: number }) =>
    s === undefined || s.sampleCount === 0
      ? "-"
      : `${esc(s.mean ?? "-")} (n=${esc(s.sampleCount)})`;
  const verificationHtml =
    v.verification === undefined
      ? ""
      : `<table>
<tr><th>Verification</th><td><code>${esc(v.verification.verificationId)}</code></td><th>Policy</th><td>${esc(v.verification.policyId)} v${esc(v.verification.policyVersion)}</td></tr>
<tr><th>Window</th><td colspan="3">${esc(v.verification.postActionWindow.start)} to ${esc(v.verification.postActionWindow.end)}</td></tr>
${
  v.verification.result === undefined
    ? ""
    : `<tr><th>Data completeness</th><td>${esc(v.verification.dataCompleteness)}</td><th>Telemetry confidence</th><td>${esc(v.verification.telemetryConfidence)}</td></tr>
<tr><th>Confidence</th><td>${esc(v.verification.confidence)}</td><th>Evidence references</th><td>${esc(v.verification.evidenceReferenceCount)}</td></tr>`
}
</table>
${
  v.verification.criteria.length === 0
    ? ""
    : `<table><tr><th>Criterion</th><th>Role</th><th>Outcome</th><th>Reference</th><th>Before</th><th>After</th><th>Reasons</th></tr>${v.verification.criteria
        .map(
          (c) =>
            `<tr><td>${esc(c.criterionId)}<br><span class="muted">${esc(c.assetId ?? "")} ${esc(c.signal ?? "")}</span></td><td>${esc(c.role)}</td><td><strong>${esc(c.outcome)}</strong></td><td>${esc(c.referenceMean ?? "-")} ${esc(c.referenceModes.join(","))}</td><td>${stat(c.before)}</td><td>${stat(c.observed)}</td><td>${esc(c.reasonCodes.join(", "))}</td></tr>`,
        )
        .join("")}</table>`
}`;
  const i = v.intervention;
  const interventionHtml =
    i === undefined
      ? "<p>No recommendation yet.</p>"
      : `<table>
<tr><th>Level</th><td><strong>${esc(i.label)}</strong> (${esc(i.status)})</td><th>Policy</th><td>${esc(i.policyId)} v${esc(i.policyVersion)}</td></tr>
<tr><th>Reason codes</th><td colspan="3">${esc(i.reasonCodes.join(", "))}</td></tr>
<tr><th>Data sufficiency</th><td>${esc(i.dataSufficiency)}</td><th>Generated</th><td>${esc(i.generatedAt)}</td></tr>
</table><p class="muted">Decision support only: it does not schedule anyone and changes no coverage or underwriting.</p>`;
  const body = `
<p><a href="/ui/cases?actor=${esc(actorId)}">&larr; all cases</a></p>
<h1>Risk Improvement Case: ${esc(v.title)}</h1>
<table>
<tr><th>Case</th><td><code>${esc(v.caseId)}</code></td><th>Case state</th><td><strong>${esc(v.state)}</strong></td></tr>
<tr><th>Hazard</th><td>${esc(v.hazardType)}</td><th>Risk event state</th><td><strong>${esc(v.riskEventState ?? "-")}</strong></td></tr>
<tr><th>Severity</th><td>${esc(v.severity)}</td><th>Facility</th><td>${esc(v.facilityId)}</td></tr>
<tr><th>Assets</th><td colspan="3">${esc(v.assetIds.join(", "))}</td></tr>
<tr><th>Reason codes</th><td colspan="3">${esc(v.reasonCodes.join(", ") || "-")}</td></tr>
</table>

<h2>What happened</h2>
<p>${esc(v.whatHappened.summary)}</p>${list(v.whatHappened.reasons)}
<p class="muted">Detections recorded: ${esc(v.detectionCount)}${v.latestDetectionAt ? ` (latest ${esc(v.latestDetectionAt)})` : ""}</p>

<h2>Accountability</h2>
<table>
<tr><th>Owner</th><td>${esc(a.ownerId ?? "not assigned")}</td></tr>
<tr><th>Alert</th><td>${esc(a.alert.status)}${a.alert.recipient ? ` to ${esc(a.alert.recipient)}` : ""}${a.alert.sentAt ? ` at ${esc(a.alert.sentAt)}` : ""} (attempts: ${esc(a.alert.attempts)})${a.alert.deliveryFailed ? " <strong>delivery failed</strong>" : ""}</td></tr>
<tr><th>Acknowledgement</th><td>${a.acknowledgement.acknowledged ? `acknowledged by ${esc(a.acknowledgement.by)} at ${esc(a.acknowledgement.at)}` : "not acknowledged"}</td></tr>
<tr><th>Escalation</th><td>${a.escalation.escalated ? `escalated at ${esc(a.escalation.at)} (${esc(a.escalation.reason)})` : "not escalated"}</td></tr>
</table>

<h2>What to do</h2>
<p class="muted">Approved actions. Symbiosis only recommends; it never operates equipment.</p>
<table><tr><th>Action</th><th>Description</th><th>Status</th></tr>${actions}</table>

<h2>What was done</h2>
${v.whatWasDone.actions.length === 0 ? "<p>No actions reported yet.</p>" : `<table><tr><th>Action</th><th>Approved action</th><th>Status</th><th>By</th><th>Reported</th><th>Notes</th></tr>${done}</table>`}

<h2>Did it work?</h2>
<p class="pending">${esc(v.didItWork.label)}</p>
<p>${esc(v.didItWork.detail)}</p>
${verificationHtml}

<h2>Is it staying fixed?</h2>
<table>
<tr><th>Recurrence watch</th><td>${esc(v.stayingFixed.watch)}${v.stayingFixed.watchEndsAt ? ` until ${esc(v.stayingFixed.watchEndsAt)}` : ""}</td></tr>
<tr><th>Recurrence count</th><td>${esc(v.stayingFixed.recurrenceCount)}</td></tr>
<tr><th>Last recurrence</th><td>${v.stayingFixed.lastRecurrence ? `${esc(v.stayingFixed.lastRecurrence.at)} (risk event <code>${esc(v.stayingFixed.lastRecurrence.riskEventId)}</code>)` : "none"}</td></tr>
</table>

<h2>Intervention recommendation</h2>
${interventionHtml}

${
  extras !== undefined
    ? evidenceAndSharingHtml(v, actorId, extras)
    : `<h2>Evidence</h2>
<p class="muted">Evidence package details are not available to this role.</p>

<h2>Sharing</h2>
<p><strong>${esc(v.sharing.state)}</strong>: ${esc(v.sharing.label)}</p>`
}
<h3>Operational audit references</h3><ul>${refs}</ul>`;
  return page(`Case ${v.caseId}`, body);
}

/** Insurer demo pages (S6): only what the sharing agreements allow, rendered from the DTOs. */
export function renderInsurerHomeHtml(
  actorId: string,
  sites: readonly InsuranceSiteView[],
  cases: readonly InsurerCaseView[],
  denial?: string,
): string {
  const a = encodeURIComponent(actorId);
  const siteRows = sites
    .map(
      (x) =>
        `<tr><td><code>${esc(x.siteId)}</code></td><td>${esc(x.insuredOrganizationId)}</td><td>${esc(x.agreements.map((g) => g.scopes.join(", ")).join(" | "))}</td></tr>`,
    )
    .join("");
  const caseRows = cases
    .map(
      (c) =>
        `<tr><td><a href="/ui/insurer/cases/${esc(c.caseId)}?actor=${a}">${esc(c.caseId)}</a></td><td>${esc(c.siteId)}</td>` +
        `<td>${esc(c.recommendation?.title ?? "(recommendation not shared)")}</td><td>${esc(c.verification?.resultLabel ?? "(result not shared)")}</td><td>${esc(c.sharingState)}</td></tr>`,
    )
    .join("");
  return page(
    "Insurer evidence",
    `<h1>Insurer evidence (consent-filtered)</h1><p class="muted">Signed in (development) as <code>${esc(actorId)}</code>. You see only what the insured has shared; there is no sensor dashboard.</p>` +
      (denial !== undefined ? `<p class="banner">${esc(denial)}</p>` : "") +
      `<h2>Sites with an active agreement</h2>${sites.length === 0 ? "<p>None.</p>" : `<table><tr><th>Site</th><th>Insured</th><th>Scopes</th></tr>${siteRows}</table>`}` +
      `<h2>Cases</h2>${cases.length === 0 ? "<p>None shared.</p>" : `<table><tr><th>Case</th><th>Site</th><th>Recommendation</th><th>Result</th><th>Sharing</th></tr>${caseRows}</table>`}`,
  );
}

export function renderInsurerCaseHtml(actorId: string, v: InsurerEvidenceView): string {
  const a = encodeURIComponent(actorId);
  const sections: string[] = [];
  if (v.source !== undefined) {
    sections.push(`<p class="banner">${esc(v.source.label)}</p>`);
  }
  if (v.recommendation !== undefined) {
    sections.push(
      `<h2>Recommendation</h2><p>${esc(v.recommendation.title)} (${esc(v.recommendation.hazardType)}, ${esc(v.recommendation.severity)}, case ${esc(v.recommendation.caseState)})</p>`,
    );
  }
  if (v.eventSummary !== undefined) {
    sections.push(
      `<h2>Event summary</h2><p>Detected ${esc(v.eventSummary.detectedAt)}: ${esc(v.eventSummary.detectionReasonCodes.join(", ") || "-")}</p>`,
    );
  }
  if (v.actionSummary !== undefined) {
    sections.push(
      `<h2>Action summary</h2><ul>${v.actionSummary.actions.map((x) => `<li>${esc(x.title ?? x.actionLibraryId)}: ${esc(x.status)} ${esc(x.reportedAt ?? "")}</li>`).join("")}</ul><p class="muted">${esc(v.actionSummary.note)}</p>`,
    );
  }
  if (v.verification !== undefined) {
    const x = v.verification;
    sections.push(
      `<h2>Verification result</h2><p class="pending">${esc(x.resultLabel)}</p><p>${esc(x.interpretation)}</p>` +
        `<p class="muted">Policy ${esc(x.policyId)} v${esc(x.policyVersion)}; evaluated ${esc(x.evaluatedAt)}; window ${esc(x.postActionWindow.start)} to ${esc(x.postActionWindow.end)}</p>` +
        `<table><tr><th>Criterion</th><th>Role</th><th>Outcome</th></tr>${x.criteria.map((c) => `<tr><td>${esc(c.criterionId)}</td><td>${esc(c.role)}</td><td>${esc(c.outcome)}</td></tr>`).join("")}</table>`,
    );
  }
  if (v.confidence !== undefined) {
    const x = v.confidence;
    sections.push(
      `<h2>Confidence and data sufficiency</h2><p>Confidence ${esc(x.confidence)}; completeness ${esc(x.dataCompleteness)}; telemetry confidence ${esc(x.telemetryConfidence)}; device ${esc(x.deviceHealthStatus)}; authentication ${esc(x.authIntegrityStatus)}</p>`,
    );
  }
  if (v.beforeAfter !== undefined) {
    sections.push(
      `<h2>Before and after</h2><table><tr><th>Criterion</th><th>Signal</th><th>Before</th><th>After</th></tr>${v.beforeAfter
        .map(
          (c) =>
            `<tr><td>${esc(c.criterionId)}</td><td>${esc(c.signal ?? "")}</td><td>${esc(c.before?.mean ?? "-")}</td><td>${esc(c.after?.mean ?? "-")}</td></tr>`,
        )
        .join("")}</table>`,
    );
  }
  if (v.recurrence !== undefined) {
    sections.push(
      `<h2>Recurrence</h2><p>At package: ${esc(v.recurrence.recurrenceCountAtPackage)}; now: ${esc(v.recurrence.currentRecurrenceCount)}; watch ends ${esc(v.recurrence.recurrenceWatchEndsAt ?? "n/a")}</p>`,
    );
  }
  if (v.evidencePackage !== undefined) {
    const x = v.evidencePackage;
    sections.push(
      `<h2>Evidence package</h2><table><tr><th>Package</th><td><code>${esc(x.packageId)}</code></td><th>Created</th><td>${esc(x.createdAt)}</td></tr>` +
        `<tr><th>Payload SHA-256</th><td colspan="3"><code>${esc(x.payloadSha256)}</code></td></tr><tr><th>Manifest SHA-256</th><td colspan="3"><code>${esc(x.manifestSha256)}</code></td></tr>` +
        `<tr><th>Integrity</th><td>${esc(x.integrity)}</td><th>Artifacts</th><td>${esc(x.artifacts.length)} (+${esc(x.observationArtifactCount)} raw observations, not shared)</td></tr></table>`,
    );
  }
  return page(
    `Case ${v.caseId}`,
    `<p><a href="/ui/insurer/cases?actor=${a}">&larr; all shared cases</a></p><h1>Shared case <code>${esc(v.caseId)}</code></h1>` +
      `<p class="muted">Site ${esc(v.siteId)}; sharing ${esc(v.sharingState)}; scopes: ${esc(v.consent.grantedScopes.join(", "))}</p>${sections.join("\n")}`,
  );
}
