import { ApiErrorView } from "../../components/ApiErrorView";
import { CaseFiltersForm, CaseTable, SummaryCards } from "../../components/Operations";
import { FlowStrip } from "../../components/FlowStrip";
import { PageHeader } from "../../components/ui";
import { loadOperations } from "../../lib/loaders";
import { getPeople, requireSession } from "../../lib/session";
import { filterCases, param, summarizeCases } from "../../lib/summary";

export const metadata = { title: "Operations" };

export default async function OperationsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const [result, people, q] = await Promise.all([
    loadOperations(session.actorId),
    getPeople(),
    searchParams,
  ]);
  const filters = {
    ...(param(q.state) !== undefined && { state: param(q.state) as string }),
    ...(param(q.severity) !== undefined && { severity: param(q.severity) as string }),
    ...(param(q.facility) !== undefined && { facility: param(q.facility) as string }),
    ...(param(q.verification) !== undefined && { verification: param(q.verification) as string }),
  };
  return (
    <>
      <PageHeader
        title="Operations"
        lead="Risk-improvement cases for your facilities: what needs a decision, what is waiting on sensors, and what is verified."
      />
      <FlowStrip compact />
      {!result.ok ? (
        <ApiErrorView error={result} session={session} subject="the operations workspace" />
      ) : (
        <>
          <SummaryCards summary={summarizeCases(result.value.cases)} />
          <h2 id="cases">Cases</h2>
          <CaseFiltersForm
            filters={filters}
            facilities={[...new Set(result.value.cases.map((c) => c.facilityId))].sort()}
          />
          <CaseTable
            cases={filterCases(result.value.cases, filters)}
            people={people}
            filtered={Object.keys(filters).length > 0}
          />
        </>
      )}
    </>
  );
}
