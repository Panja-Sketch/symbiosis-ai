import Link from "next/link";
import { formatTime } from "../lib/format";
import { orgLabel } from "../lib/identity";
import type { OrgNames } from "../lib/identity";
import { STATUS, STATUS_FOR_RESULT, hazardLabel } from "../lib/labels";
import type { CaseDto, SharingState } from "../lib/types";
import { EmptyState, ToneBadge } from "./ui";

const SHARING: Readonly<
  Record<SharingState, { label: string; tone: "neutral" | "info" | "good" | "warn"; icon: string }>
> = {
  NOT_SHARED: { label: "No package yet", tone: "neutral", icon: "–" },
  SHAREABLE: { label: "Shareable", tone: "info", icon: "◔" },
  SHARED: { label: "Shared", tone: "good", icon: "✓" },
  REVOKED: { label: "Revoked", tone: "warn", icon: "✕" },
};

/** Evidence packages and who can see them, one row per case. Detail and controls live on the case. */
export function EvidenceOverview({
  cases,
  orgNames,
}: {
  readonly cases: readonly CaseDto[];
  readonly orgNames: OrgNames;
}) {
  if (cases.length === 0) {
    return (
      <EmptyState title="No evidence yet">
        <p>Evidence packages are created automatically when a verification completes.</p>
      </EmptyState>
    );
  }
  return (
    <div className="table-wrap">
      <table className="cases-table">
        <caption className="visually-hidden">Evidence packages and sharing</caption>
        <thead>
          <tr>
            <th scope="col">Case</th>
            <th scope="col">Latest evidence package</th>
            <th scope="col">Result recorded</th>
            <th scope="col">Sharing</th>
            <th scope="col">Shared with</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const latest = c.evidencePackages?.at(-1);
            const result = latest === undefined ? undefined : STATUS_FOR_RESULT[latest.result];
            const active = (c.sharingAgreements ?? []).filter((g) => g.status === "ACTIVE");
            const sh = SHARING[c.sharing.state];
            return (
              <tr key={c.caseId} data-case-id={c.caseId} data-sharing-state={c.sharing.state}>
                <th scope="row" data-label="Case">
                  <Link href={`/operations/cases/${encodeURIComponent(c.caseId)}#sharing`}>
                    {hazardLabel(c.hazardType)}
                  </Link>
                  <span className="cell-sub">{c.caseId}</span>
                </th>
                <td data-label="Latest evidence package">
                  {latest === undefined ? (
                    <span className="muted">None yet</span>
                  ) : (
                    <>
                      <code>{latest.packageId}</code>
                      <span className="cell-sub">{formatTime(latest.createdAt)}</span>
                    </>
                  )}
                </td>
                <td data-label="Result recorded">
                  {result === undefined ? "—" : STATUS[result].label}
                </td>
                <td data-label="Sharing">
                  <ToneBadge tone={sh.tone} icon={sh.icon}>
                    {sh.label}
                  </ToneBadge>
                </td>
                <td data-label="Shared with">
                  {active.length === 0
                    ? "Nobody"
                    : active
                        .map((g) => orgLabel(orgNames, g.agreement.recipientOrganizationId))
                        .join(", ")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
