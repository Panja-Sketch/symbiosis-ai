import { ApiErrorView } from "../../../../components/ApiErrorView";
import { CaseDetail } from "../../../../components/CaseDetail";
import { NOTICES } from "../../../../lib/notices";
import { loadCase } from "../../../../lib/loaders";
import { getDirectory, getOrgNames, getPeople, requireSession } from "../../../../lib/session";

export const metadata = { title: "Case" };

export default async function CasePage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ id: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, q, session] = await Promise.all([params, searchParams, requireSession()]);
  const [result, directory, people, orgNames] = await Promise.all([
    loadCase(session.actorId, id),
    getDirectory(),
    getPeople(),
    getOrgNames(),
  ]);
  if (!result.ok) {
    return <ApiErrorView error={result} session={session} subject="this case" />;
  }
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const noticeKey = one(q.notice);
  return (
    <CaseDetail
      data={result.value}
      session={session}
      people={people}
      orgNames={orgNames}
      assignees={(directory?.actors ?? []).filter(
        (a) =>
          a.organizationId === session.organizationId &&
          a.permissions.includes("ACTION_ACKNOWLEDGE"),
      )}
      insurers={(directory?.organizations ?? []).filter((o) => o.type === "INSURER")}
      notice={noticeKey === undefined ? undefined : NOTICES[noticeKey]}
      error={one(q.error) === undefined ? undefined : (one(q.msg) ?? "The request was rejected.")}
    />
  );
}
