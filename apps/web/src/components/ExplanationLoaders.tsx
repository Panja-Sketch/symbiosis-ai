import { loadExplanation, loadInsurerExplanation } from "../lib/loaders";
import { ExplanationPanel } from "./ExplanationPanel";

/**
 * Async server components, rendered inside <Suspense> so the deterministic page streams first and
 * the explanation fills in afterwards. An explanation failure renders a quiet notice; it never
 * throws, so it can never take the case page down.
 */
export async function FacilityExplanation({
  actorId,
  caseId,
}: {
  actorId: string;
  caseId: string;
}) {
  return <ExplanationPanel result={await loadExplanation(actorId, caseId)} audience="FACILITY" />;
}

export async function InsurerExplanation({ actorId, caseId }: { actorId: string; caseId: string }) {
  return (
    <ExplanationPanel result={await loadInsurerExplanation(actorId, caseId)} audience="INSURER" />
  );
}
