import { ApiErrorView } from "../../../../components/ApiErrorView";
import { InsurerCaseDetail } from "../../../../components/InsurerCaseDetail";
import { loadInsurerCase } from "../../../../lib/loaders";
import { requireSession } from "../../../../lib/session";

export const metadata = { title: "Shared case" };

export default async function InsurerCasePage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const [{ id }, session] = await Promise.all([params, requireSession()]);
  const result = await loadInsurerCase(session.actorId, id);
  if (!result.ok) {
    return <ApiErrorView error={result} session={session} subject="this shared case" />;
  }
  return <InsurerCaseDetail data={result.value} />;
}
