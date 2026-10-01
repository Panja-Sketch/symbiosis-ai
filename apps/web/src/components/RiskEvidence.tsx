import Link from "next/link";
import { formatTime } from "../lib/format";
import { orgLabel } from "../lib/identity";
import type { OrgNames } from "../lib/identity";
import { currentInterventions } from "../lib/insurer";
import type { RiskEvidenceSummary } from "../lib/insurer";
import {
  INTERVENTION_INFO,
  SCOPE_INFO,
  STATUS_FOR_RESULT,
  hazardLabel,
  statusForState,
} from "../lib/labels";
import type { SiteWithCases } from "../lib/loaders";
import type {
  ConsentScope,
  InsurerCaseDto,
  InsurerInterventionDto,
  InsurerSiteDto,
  InterventionLevel,
} from "../lib/types";
import { InterventionPanel } from "./InterventionPanel";
import { EmptyState, StatusBadge, SyntheticBadge, ToneBadge } from "./ui";

export function RiskEvidenceCards({ summary }: { readonly summary: RiskEvidenceSummary }) {
  const cards: readonly { key: string; label: string; value: number; hint: string }[] = [
    {
      key: "sites",
      label: "Shared sites",
      value: summary.sites,
      hint: "Facilities covered by an active agreement",
    },
    { key: "open", label: "Active shared cases", value: summary.open, hint: "Cases not closed" },
    {
      key: "verified",
      label: "Verified improved",
      value: summary.verified,
      hint: "Sensor-verified outcomes",
    },
    {
      key: "partial",
      label: "Partially verified",
      value: summary.partial,
      hint: "Improved, target not reached",
    },
    {
      key: "not-improving",
      label: "Not improving",
      value: summary.notImproving,
      hint: "Condition persists",
    },
    {
      key: "inconclusive",
      label: "Inconclusive",
      value: summary.inconclusive,
      hint: "Evidence could not settle it",
    },
    {
      key: "recurrence",
      label: "Recurrence",
      value: summary.recurrence,
      hint: "The hazard returned",
    },
    {
      key: "review",
      label: "Review recommended",
      value: summary.needsReview,
      hint: "Risk Engineer Review or Site Visit Recommended",
    },
    {
      key: "evidence-missing",
      label: "Evidence not yet available",
      value: summary.evidenceMissing,
      hint: "No evidence package shared yet",
    },
  ];
  return (
    <ul className="stat-grid" aria-label="Shared evidence summary">
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

/** A level pill. The wording is always a recommendation, never an event that has happened. */
export function LevelBadge({ level, label }: { readonly level: string; readonly label?: string }) {
  const tone =
    level === "SITE_VISIT_RECOMMENDED"
      ? "danger"
      : level === "RISK_ENGINEER_REVIEW"
        ? "warn"
        : level === "REMOTE_REVIEW"
          ? "info"
          : "good";
  return (
    <ToneBadge tone={tone} icon="◆">
      {INTERVENTION_INFO[level as InterventionLevel]?.label ?? label ?? level}
    </ToneBadge>
  );
}

const SCOPE_ORDER = Object.keys(SCOPE_INFO) as ConsentScope[];

export function ScopeChips({ scopes }: { readonly scopes: readonly ConsentScope[] }) {
  return (
    <ul className="scope-chips" aria-label="Scopes shared">
      {SCOPE_ORDER.filter((s) => scopes.includes(s)).map((s) => (
        <li key={s} title={SCOPE_INFO[s].plain}>
          {SCOPE_INFO[s].label}
        </li>
      ))}
    </ul>
  );
}

export function InsurerCaseTable({
  cases,
  interventions,
}: {
  readonly cases: readonly InsurerCaseDto[];
  readonly interventions: readonly InsurerInterventionDto[];
}) {
  const current = currentInterventions(interventions);
  if (cases.length === 0) {
    return (
      <EmptyState title="No shared cases">
        <p>The customer has not shared any cases for this selection yet.</p>
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="cases-table">
        <caption className="visually-hidden">Shared cases</caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Site</th>
            <th scope="col">Verification outcome</th>
            <th scope="col">Recurrence</th>
            <th scope="col">Recommendation</th>
            <th scope="col">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const r =
              c.verification === undefined ? undefined : STATUS_FOR_RESULT[c.verification.result];
            const i = current.get(c.caseId);
            return (
              <tr key={c.caseId} data-case-id={c.caseId}>
                <th scope="row" data-label="Case">
                  <Link href={`/risk-evidence/cases/${encodeURIComponent(c.caseId)}`}>
                    {c.recommendation !== undefined
                      ? hazardLabel(c.recommendation.hazardType)
                      : "Shared case"}
                  </Link>
                  <span className="cell-sub">{c.caseId}</span>
                </th>
                <td data-label="Site">
                  <Link href={`/risk-evidence/sites/${encodeURIComponent(c.siteId)}`}>
                    {c.siteId}
                  </Link>
                </td>
                <td data-label="Verification outcome">
                  {r !== undefined ? (
                    <StatusBadge status={r} />
                  ) : c.recommendation !== undefined ? (
                    <StatusBadge status={statusForState(c.recommendation.caseState).key} />
                  ) : (
                    <span className="muted">Not shared</span>
                  )}
                </td>
                <td data-label="Recurrence">
                  {c.recurrence === undefined
                    ? "Not shared"
                    : c.recurrence.currentRecurrenceCount > 0
                      ? `${c.recurrence.currentRecurrenceCount} (returned)`
                      : "None"}
                </td>
                <td data-label="Recommendation">
                  {i !== undefined ? (
                    <LevelBadge level={i.level} label={i.label} />
                  ) : (
                    <span className="muted">Not shared</span>
                  )}
                </td>
                <td data-label="Evidence">
                  {c.evidenceAvailable === true
                    ? "Package available"
                    : c.evidenceAvailable === false
                      ? "Not yet available"
                      : "Not shared"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function SiteCards({
  sites,
  orgNames,
}: {
  readonly sites: readonly SiteWithCases[];
  readonly orgNames: OrgNames;
}) {
  if (sites.length === 0) {
    return (
      <EmptyState title="No sites are shared with you">
        <p>
          A customer must grant a sharing agreement before any site appears here. Nothing else is
          visible: there is no access to unshared facilities or live telemetry.
        </p>
      </EmptyState>
    );
  }
  return (
    <ul className="site-cards">
      {sites.map(({ site, cases }) => (
        <li key={site.siteId} className="card">
          <h3>
            <Link href={`/risk-evidence/sites/${encodeURIComponent(site.siteId)}`}>
              {site.siteId}
            </Link>
          </h3>
          <p className="muted">{orgLabel(orgNames, site.insuredOrganizationId)}</p>
          <p>
            {cases.length} shared case{cases.length === 1 ? "" : "s"}
          </p>
          <SiteScopes site={site} />
        </li>
      ))}
    </ul>
  );
}

export function SiteScopes({ site }: { readonly site: InsurerSiteDto }) {
  const scopes = [...new Set(site.agreements.flatMap((a) => a.scopes))];
  return (
    <>
      <ScopeChips scopes={scopes} />
      <p className="muted">
        {site.agreements.length} active agreement{site.agreements.length === 1 ? "" : "s"} · from{" "}
        {formatTime(site.agreements[0]?.effectiveFrom)}
        {site.agreements.some((a) => a.expiresAt !== undefined)
          ? " · has an end date"
          : " · until revoked"}
      </p>
    </>
  );
}

export function InterventionList({
  interventions,
}: {
  readonly interventions: readonly InsurerInterventionDto[];
}) {
  const current = [...currentInterventions(interventions).values()];
  if (current.length === 0) {
    return (
      <EmptyState title="No recommendations to show">
        <p>
          Recommendations appear for cases the customer has shared with the recommendation scope.
        </p>
      </EmptyState>
    );
  }
  const order: readonly string[] = [
    "SITE_VISIT_RECOMMENDED",
    "RISK_ENGINEER_REVIEW",
    "REMOTE_REVIEW",
    "REMOTE_MONITORING",
  ];
  const sorted = [...current].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  return (
    <ul className="intervention-list">
      {sorted.map((i) => (
        <li key={i.interventionId} className="card" data-case-id={i.caseId}>
          <p className="muted">
            Site {i.siteId} ·{" "}
            {i.caseId !== undefined ? (
              <Link href={`/risk-evidence/cases/${encodeURIComponent(i.caseId)}`}>{i.caseId}</Link>
            ) : (
              "case not shared"
            )}
          </p>
          <InterventionPanel intervention={i} />
        </li>
      ))}
    </ul>
  );
}

export function SyntheticNote({ source }: { readonly source?: InsurerCaseDto["source"] }) {
  return source === undefined ? null : source.synthetic ? (
    <SyntheticBadge label={source.label} />
  ) : (
    <span>{source.label}</span>
  );
}
