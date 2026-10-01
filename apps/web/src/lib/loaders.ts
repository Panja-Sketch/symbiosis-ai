import { apiGet } from "./api";
import type { ApiResult } from "./api";
import type {
  CaseDto,
  DirectoryDto,
  EvidenceDetailDto,
  ExplanationDto,
  InsurerCaseDto,
  InsurerInterventionDto,
  InsurerSiteDto,
  MeDto,
} from "./types";

/**
 * Page data loaders. Each one is a handful of GETs against the HTTP API with the caller's
 * development identity; none computes a risk, verification, recurrence, consent or intervention
 * decision. They only fetch and assemble what the API already decided.
 */

export const loadDirectory = () => apiGet<DirectoryDto>(undefined, "/api/v1/dev/identities");
export const loadMe = (actorId: string) => apiGet<MeDto>(actorId, "/api/v1/me");

const fail = <T>(r: ApiResult<unknown>): ApiResult<T> => r as ApiResult<T>;

// ---- facility / customer side (/api/v1) ----------------------------------------------------------

export type OperationsData = { readonly cases: readonly CaseDto[] };

/** The list endpoint returns summaries; each row is completed from the case endpoint. */
export async function loadOperations(actorId: string): Promise<ApiResult<OperationsData>> {
  const list = await apiGet<{ cases: readonly { caseId: string }[] }>(actorId, "/api/v1/cases");
  if (!list.ok) return fail(list);
  const details = await Promise.all(
    list.value.cases.map((c) =>
      apiGet<CaseDto>(actorId, `/api/v1/cases/${encodeURIComponent(c.caseId)}`),
    ),
  );
  const cases: CaseDto[] = [];
  for (const d of details) {
    if (d.ok) cases.push(d.value);
  }
  const lastUpdate = (c: CaseDto) => c.evidence.auditReferences.at(-1)?.at ?? "";
  cases.sort((a, b) => lastUpdate(b).localeCompare(lastUpdate(a)));
  return { ok: true, value: { cases } };
}

export type CaseData = {
  readonly case: CaseDto;
  /** The latest package with a live integrity check, when the role may read evidence. */
  readonly evidence?: EvidenceDetailDto;
  readonly evidenceError?: string;
};

export async function loadCase(actorId: string, caseId: string): Promise<ApiResult<CaseData>> {
  const c = await apiGet<CaseDto>(actorId, `/api/v1/cases/${encodeURIComponent(caseId)}`);
  if (!c.ok) return fail(c);
  const pkgId = c.value.evidence.latestEvidencePackageId;
  if (pkgId === undefined || c.value.evidencePackages === undefined) {
    return { ok: true, value: { case: c.value } };
  }
  const e = await apiGet<EvidenceDetailDto>(
    actorId,
    `/api/v1/evidence/${encodeURIComponent(pkgId)}`,
  );
  return {
    ok: true,
    value: {
      case: c.value,
      ...(e.ok ? { evidence: e.value } : { evidenceError: e.message }),
    },
  };
}

// ---- insurer side (/insurance/v1) ---------------------------------------------------------------

export type SiteWithCases = {
  readonly site: InsurerSiteDto;
  readonly cases: readonly InsurerCaseDto[];
};
export type RiskEvidenceData = {
  readonly sites: readonly SiteWithCases[];
  readonly interventions: readonly InsurerInterventionDto[];
};

export async function loadRiskEvidence(actorId: string): Promise<ApiResult<RiskEvidenceData>> {
  const sites = await apiGet<{ sites: readonly InsurerSiteDto[] }>(actorId, "/insurance/v1/sites");
  if (!sites.ok) return fail(sites);
  const withCases = await Promise.all(
    sites.value.sites.map(async (site) => {
      const r = await apiGet<{ cases: readonly InsurerCaseDto[] }>(
        actorId,
        `/insurance/v1/sites/${encodeURIComponent(site.siteId)}/cases`,
      );
      return { site, cases: r.ok ? r.value.cases : [] };
    }),
  );
  const ints = await apiGet<{ interventions: readonly InsurerInterventionDto[] }>(
    actorId,
    "/insurance/v1/interventions",
  );
  return {
    ok: true,
    value: { sites: withCases, interventions: ints.ok ? ints.value.interventions : [] },
  };
}

export type InsurerCaseData = {
  readonly view: InsurerCaseDto;
  readonly intervention?: InsurerInterventionDto;
};

export async function loadInsurerCase(
  actorId: string,
  caseId: string,
): Promise<ApiResult<InsurerCaseData>> {
  const r = await apiGet<InsurerCaseDto>(
    actorId,
    `/insurance/v1/cases/${encodeURIComponent(caseId)}/evidence`,
  );
  if (!r.ok) return fail(r);
  const ints = await apiGet<{ interventions: readonly InsurerInterventionDto[] }>(
    actorId,
    "/insurance/v1/interventions",
  );
  const mine = ints.ok
    ? ints.value.interventions.find((i) => i.caseId === caseId && i.status !== "SUPERSEDED")
    : undefined;
  return { ok: true, value: { view: r.value, ...(mine !== undefined && { intervention: mine }) } };
}

// ---- explanations (S8) ----------------------------------------------------------------------------

/** Facility explanation: built by the API from the same case view the page shows. */
export const loadExplanation = (actorId: string, caseId: string) =>
  apiGet<ExplanationDto>(actorId, `/api/v1/cases/${encodeURIComponent(caseId)}/explanation`);

/** Insurer explanation: built by the API from the consent-filtered projection only. */
export const loadInsurerExplanation = (actorId: string, caseId: string) =>
  apiGet<ExplanationDto>(actorId, `/insurance/v1/cases/${encodeURIComponent(caseId)}/explanation`);
