import { ApiErrorView } from "../../../components/ApiErrorView";
import { SiteCards } from "../../../components/RiskEvidence";
import { PageHeader } from "../../../components/ui";
import { loadRiskEvidence } from "../../../lib/loaders";
import { getOrgNames, requireSession } from "../../../lib/session";

export const metadata = { title: "Sites" };

export default async function SitesPage() {
  const session = await requireSession();
  const [result, orgNames] = await Promise.all([loadRiskEvidence(session.actorId), getOrgNames()]);
  return (
    <>
      <PageHeader
        title="Sites"
        lead="Only facilities covered by an active sharing agreement appear here."
      />
      {!result.ok ? (
        <ApiErrorView error={result} session={session} subject="the sites list" />
      ) : (
        <SiteCards sites={result.value.sites} orgNames={orgNames} />
      )}
    </>
  );
}
