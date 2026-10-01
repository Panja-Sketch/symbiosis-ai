import { ApiErrorView } from "../../../components/ApiErrorView";
import { EvidenceOverview } from "../../../components/EvidenceOverview";
import { TrustExplainer } from "../../../components/TrustExplainer";
import { PageHeader } from "../../../components/ui";
import { loadOperations } from "../../../lib/loaders";
import { getOrgNames, requireSession } from "../../../lib/session";

export const metadata = { title: "Evidence & sharing" };

export default async function EvidenceSharingPage() {
  const session = await requireSession();
  const [result, orgNames] = await Promise.all([loadOperations(session.actorId), getOrgNames()]);
  return (
    <>
      <PageHeader
        title="Evidence & sharing"
        lead="Every completed verification produces an immutable evidence package. You decide whether an insurer sees it, and exactly what."
      />
      {!result.ok ? (
        <ApiErrorView error={result} session={session} subject="evidence and sharing" />
      ) : (
        <EvidenceOverview cases={result.value.cases} orgNames={orgNames} />
      )}
      <TrustExplainer />
    </>
  );
}
