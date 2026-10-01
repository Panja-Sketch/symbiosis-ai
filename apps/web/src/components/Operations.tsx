import Link from "next/link";
import { personLabel } from "../lib/identity";
import type { People } from "../lib/identity";
import { formatTime } from "../lib/format";
import {
  INTERVENTION_INFO,
  STATUS_FOR_DID_IT_WORK,
  hazardLabel,
  statusForState,
} from "../lib/labels";
import { lastUpdate } from "../lib/summary";
import type { CaseFilters, OperationsSummary } from "../lib/summary";
import type { CaseDto, InterventionLevel } from "../lib/types";
import { EmptyState, SeverityBadge, StatusBadge } from "./ui";

export function SummaryCards({ summary }: { readonly summary: OperationsSummary }) {
  const cards: readonly { key: string; label: string; value: number; hint: string }[] = [
    {
      key: "open",
      label: "Open cases",
      value: summary.open,
      hint: "Risk-improvement cases not closed",
    },
    {
      key: "action",
      label: "Action required",
      value: summary.actionRequired,
      hint: "Need a person's next step",
    },
    {
      key: "pending",
      label: "Verification pending",
      value: summary.verificationPending,
      hint: "Action reported; sensors not yet conclusive",
    },
    {
      key: "verified",
      label: "Verified improved",
      value: summary.verifiedImproved,
      hint: "Sensor-verified, not just reported",
    },
    {
      key: "recurrence",
      label: "Recurrence / reopened",
      value: summary.recurrence,
      hint: "The hazard came back",
    },
    {
      key: "review",
      label: "Needs professional review",
      value: summary.needsReview,
      hint: "Risk-engineer review or site visit recommended",
    },
  ];
  return (
    <ul className="stat-grid" aria-label="Case summary">
      {cards.map((c) => (
        <li key={c.key} className="stat" data-stat={c.key}>
          <span className="stat-value">{c.value}</span>
          <span className="stat-label">{c.label}</span>
          <span className="stat-hint">{c.hint}</span>
        </li>
      ))}
    </ul>
  );
}

const STATE_OPTIONS = [
  "OPEN",
  "ACTION_REQUIRED",
  "ACTION_REPORTED",
  "VERIFYING",
  "VERIFIED_IMPROVED",
  "PARTIALLY_VERIFIED",
  "NOT_IMPROVING",
  "INCONCLUSIVE",
  "REOPENED",
  "CLOSED",
] as const;
const VERIFICATION_OPTIONS = [
  ["NOT_APPLICABLE_YET", "No action reported yet"],
  ["VERIFICATION_PENDING", "Verification pending"],
  ["VERIFIED_IMPROVED", "Verified improved"],
  ["PARTIALLY_VERIFIED", "Partially verified"],
  ["NOT_IMPROVING", "Not improving"],
  ["INCONCLUSIVE", "Inconclusive"],
] as const;

export function CaseFiltersForm({
  filters,
  facilities,
}: {
  readonly filters: CaseFilters;
  readonly facilities: readonly string[];
}) {
  return (
    <form method="get" className="filters" aria-label="Filter cases">
      <label>
        State
        <select name="state" defaultValue={filters.state ?? "ALL"}>
          <option value="ALL">All states</option>
          {STATE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {statusForState(s).label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Severity
        <select name="severity" defaultValue={filters.severity ?? "ALL"}>
          <option value="ALL">All severities</option>
          {["CRITICAL", "HIGH", "MODERATE", "LOW"].map((s) => (
            <option key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </option>
          ))}
        </select>
      </label>
      <label>
        Facility
        <select name="facility" defaultValue={filters.facility ?? "ALL"}>
          <option value="ALL">All facilities</option>
          {facilities.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label>
        Verification
        <select name="verification" defaultValue={filters.verification ?? "ALL"}>
          <option value="ALL">Any result</option>
          {VERIFICATION_OPTIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <div className="filters-actions">
        <button type="submit" className="btn btn-primary btn-small">
          Apply filters
        </button>
        <Link className="btn btn-small btn-quiet" href="/operations">
          Reset
        </Link>
      </div>
    </form>
  );
}

function VerificationCell({ c }: { readonly c: CaseDto }) {
  const key = STATUS_FOR_DID_IT_WORK[c.didItWork.status];
  return key === undefined ? (
    <span className="muted">{c.didItWork.label}</span>
  ) : (
    <StatusBadge status={key} />
  );
}

export function CaseTable({
  cases,
  people,
  filtered,
}: {
  readonly cases: readonly CaseDto[];
  readonly people: People;
  readonly filtered: boolean;
}) {
  if (cases.length === 0) {
    return filtered ? (
      <EmptyState title="No cases match these filters">
        <p>Try clearing a filter.</p>
      </EmptyState>
    ) : (
      <EmptyState title="No risk-improvement cases yet">
        <p>
          Nothing has been detected. When a persistent risk pattern is found in trusted sensor data,
          a case appears here and the responsible people are alerted.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="cases-table">
        <caption className="visually-hidden">Risk-improvement cases</caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Facility / assets</th>
            <th scope="col">Severity</th>
            <th scope="col">State</th>
            <th scope="col">Owner</th>
            <th scope="col">Last update</th>
            <th scope="col">Verification</th>
            <th scope="col">Recurrences</th>
            <th scope="col">Intervention level</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const st = statusForState(c.state);
            return (
              <tr key={c.caseId} data-case-id={c.caseId} data-state={c.state}>
                <th scope="row" data-label="Case">
                  <Link href={`/operations/cases/${encodeURIComponent(c.caseId)}`}>
                    {hazardLabel(c.hazardType)}
                  </Link>
                  <span className="cell-sub">{c.caseId}</span>
                </th>
                <td data-label="Facility / assets">
                  {c.facilityId}
                  <span className="cell-sub">{c.assetIds.join(", ")}</span>
                </td>
                <td data-label="Severity">
                  <SeverityBadge severity={c.severity} />
                </td>
                <td data-label="State">
                  <StatusBadge status={st.key} />
                </td>
                <td data-label="Owner">{personLabel(people, c.accountability.ownerId)}</td>
                <td data-label="Last update">{formatTime(lastUpdate(c))}</td>
                <td data-label="Verification">
                  <VerificationCell c={c} />
                </td>
                <td data-label="Recurrences">{c.stayingFixed.recurrenceCount}</td>
                <td data-label="Intervention level">
                  {c.intervention === undefined
                    ? "—"
                    : (INTERVENTION_INFO[c.intervention.level as InterventionLevel]?.label ??
                      c.intervention.label)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
