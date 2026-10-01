import { ApiErrorView } from "../../../components/ApiErrorView";
import { InterventionList } from "../../../components/RiskEvidence";
import { PageHeader } from "../../../components/ui";
import { loadRiskEvidence } from "../../../lib/loaders";
import { INTERVENTION_NOTE } from "../../../lib/labels";
import { requireSession } from "../../../lib/session";

export const metadata = { title: "Interventions" };

export default async function InterventionsPage() {
  const session = await requireSession();
  const result = await loadRiskEvidence(session.actorId);
  return (
    <>
      <PageHeader
        title="Interventions"
        lead="Deterministic recommendations about where a closer look may be warranted, for shared cases only."
      />
      <p className="note">{INTERVENTION_NOTE}</p>
      {!result.ok ? (
        <ApiErrorView error={result} session={session} subject="the interventions list" />
      ) : (
        <InterventionList interventions={result.value.interventions} />
      )}
    </>
  );
}
