import { ApiErrorView } from "../../components/ApiErrorView";
import { FlowStrip } from "../../components/FlowStrip";
import { InsurerCaseTable, RiskEvidenceCards, SiteCards } from "../../components/RiskEvidence";
import { PageHeader } from "../../components/ui";
import { summarizeRiskEvidence } from "../../lib/insurer";
import { loadRiskEvidence } from "../../lib/loaders";
import { getOrgNames, requireSession } from "../../lib/session";

export const metadata = { title: "Risk Evidence" };

export default async function RiskEvidencePage() {
  const session = await requireSession();
  const [result, orgNames] = await Promise.all([loadRiskEvidence(session.actorId), getOrgNames()]);
  return (
    <>
      <PageHeader
        title="Risk Evidence"
        lead="Verified evidence from the customers who have shared it with you. You see sites, outcomes and evidence, not live sensor data."
      />
      <FlowStrip compact />
      {!result.ok ? (
        <ApiErrorView error={result} session={session} subject="the risk evidence workspace" />
      ) : result.value.sites.length === 0 ? (
        <SiteCards sites={[]} orgNames={orgNames} />
      ) : (
        <>
          <RiskEvidenceCards
            summary={summarizeRiskEvidence(result.value.sites, result.value.interventions)}
          />
          <h2>Shared sites</h2>
          <SiteCards sites={result.value.sites} orgNames={orgNames} />
          <h2>Shared cases</h2>
          <InsurerCaseTable
            cases={result.value.sites.flatMap((s) => s.cases)}
            interventions={result.value.interventions}
          />
        </>
      )}
    </>
  );
}
