import Link from "next/link";
import { ApiErrorView } from "../../../../components/ApiErrorView";
import {
  InsurerCaseTable,
  InterventionList,
  SiteScopes,
} from "../../../../components/RiskEvidence";
import { EmptyState, PageHeader } from "../../../../components/ui";
import { orgLabel } from "../../../../lib/identity";
import { loadRiskEvidence } from "../../../../lib/loaders";
import { getOrgNames, requireSession } from "../../../../lib/session";

export const metadata = { title: "Site" };

export default async function SitePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const [{ id }, session] = await Promise.all([params, requireSession()]);
  const [result, orgNames] = await Promise.all([loadRiskEvidence(session.actorId), getOrgNames()]);
  if (!result.ok) return <ApiErrorView error={result} session={session} subject="this site" />;
  const entry = result.value.sites.find((s) => s.site.siteId === id);
  if (entry === undefined) {
    // Same answer for a site that does not exist and one that is simply not shared.
    return (
      <EmptyState title="This site is not shared with you">
        <p>
          No active sharing agreement covers site <code>{id}</code>. It may not exist, or the
          customer has not shared it (or has revoked sharing).
        </p>
        <p>
          <Link className="btn" href="/risk-evidence">
            Back to Risk Evidence
          </Link>
        </p>
      </EmptyState>
    );
  }
  const ids = new Set(entry.cases.map((c) => c.caseId));
  return (
    <>
      <p className="crumbs">
        <Link href="/risk-evidence">← Risk Evidence</Link>
      </p>
      <PageHeader
        title={`Site ${entry.site.siteId}`}
        lead={`${orgLabel(orgNames, entry.site.insuredOrganizationId)} · consented cases and evidence only`}
      />
      <h2>What the customer shared for this site</h2>
      <SiteScopes site={entry.site} />
      <h2>Cases</h2>
      <InsurerCaseTable cases={entry.cases} interventions={result.value.interventions} />
      <h2>Recommendations</h2>
      <InterventionList
        interventions={result.value.interventions.filter(
          (i) => i.caseId !== undefined && ids.has(i.caseId),
        )}
      />
    </>
  );
}
