import type { CaseView, CaseViewSummary } from "@symbiosis/action-orchestration";

/**
 * MINIMAL S4 WORKFLOW-PROOF PAGES. They exist to show: detected -> alert -> acknowledgement ->
 * action report -> verification pending. They are server-rendered, read-only HTML with no
 * scripts, and are NOT the final UI: S7 builds the Operations Workspace, Risk Evidence
 * Workspace, portfolio view and Trust Center (Next.js). Nothing here can claim physical
 * improvement, because that check does not exist until S5.
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

export function renderCaseHtml(v: CaseView, actorId: string): string {
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

<h2>Evidence</h2>
<p class="muted">Operational audit references only. No evidence package exists yet.</p><ul>${refs}</ul>

<h2>Sharing</h2>
<p>${esc(v.sharing.label)}</p>`;
  return page(`Case ${v.caseId}`, body);
}
