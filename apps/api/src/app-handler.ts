import type { Operations, OperationsError } from "@symbiosis/action-orchestration";
import type {
  InterventionError,
  InterventionService,
} from "@symbiosis/intervention-prioritization";
import { buildFacilityContext } from "@symbiosis/ai-explanation";
import type { EvidenceInput, ExplanationService } from "@symbiosis/ai-explanation";
import { can } from "@symbiosis/authz";
import { permissionsFor } from "@symbiosis/authz";
import { EVIDENCE_CONSENT_SCOPES } from "@symbiosis/contracts";
import type { ConsentError, InsuranceGateway, SharingService } from "@symbiosis/consent";
import type { EvidenceError, EvidenceService } from "@symbiosis/evidence";
import { DemoHeaderIdentityResolver } from "@symbiosis/tenancy";
import type {
  ActorContext,
  ActorDirectory,
  IdentityResolver,
  OrganizationRecord,
} from "@symbiosis/tenancy";
import { RESULT_LABELS } from "@symbiosis/verification";
import type { EdgeRequest, EdgeResponse } from "./edge-handler";
import type { CaseEvidenceExtras } from "./html";
import {
  renderCaseHtml,
  renderCaseListHtml,
  renderErrorHtml,
  renderInsurerCaseHtml,
  renderInsurerHomeHtml,
} from "./html";

export type AppApiDeps = {
  readonly operations: Operations;
  readonly interventions: InterventionService;
  readonly evidence: EvidenceService;
  readonly sharing: SharingService;
  /** Used only by the minimal insurer demo pages; the JSON API is `createInsuranceHandler`. */
  readonly insurance: InsuranceGateway;
  readonly directory: ActorDirectory;
  /**
   * How the caller is identified. Absent means the local development resolver over `directory`
   * (`X-Demo-Actor-Id`). Production passes a verified-token resolver; the `/ui` proof pages then do
   * not exist because they identify the caller from the URL.
   */
  readonly identity?: IdentityResolver;
  /**
   * Local-only maintenance hook: runs the escalation evaluator and alert retries once. Absent
   * means the route does not exist. Cloud mode will use Cloud Scheduler instead (S9).
   */
  readonly runTick?: () => Promise<unknown>;
  /**
   * Local-only: the synthetic identities the web app's development identity switcher may offer
   * (S7). Absent means the route does not exist. It lists directory entries only; choosing one
   * still goes through the same server-side directory lookup as every other request.
   */
  /** Optional explanation layer (S8). Absent means the explanation route does not exist. */
  readonly explanations?: ExplanationService;
  readonly devIdentities?: {
    readonly actors: readonly ActorContext[];
    readonly organizations: readonly OrganizationRecord[];
  };
};

const STATUS: Record<OperationsError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  CONFLICT: 409,
};

const fromInterventionError = (e: InterventionError): EdgeResponse =>
  json(STATUS[e.code], { error: { code: e.code, message: e.message } });

const EVIDENCE_STATUS: Record<EvidenceError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  VERIFICATION_NOT_COMPLETED: 409,
  UNRESOLVED_EVIDENCE: 409,
  INCONSISTENT_SOURCE: 409,
  SERIALIZATION_FAILURE: 500,
  STORAGE_FAILURE: 500,
  INTEGRITY_FAILURE: 500,
};
const fromEvidenceError = (e: EvidenceError): EdgeResponse =>
  json(EVIDENCE_STATUS[e.code], {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined && { details: e.details }),
    },
  });
const fromConsentError = (e: ConsentError): EdgeResponse =>
  json(STATUS[e.code], {
    error: {
      code: e.code,
      message: e.message,
      ...(e.details !== undefined && { details: e.details }),
    },
  });

const json = (status: number, body: unknown): EdgeResponse => ({ status, body });
const problem = (status: number, code: string, message: string): EdgeResponse =>
  json(status, { error: { code, message } });
const fromError = (e: OperationsError): EdgeResponse =>
  json(STATUS[e.code], {
    error: {
      code: e.code,
      message: e.message,
      ...(e.domain !== undefined && { domainCode: e.domain.code }),
    },
  });

const STATUS_FOR_INSURANCE = {
  FORBIDDEN: 403,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  INTEGRITY_FAILURE: 500,
  AUDIT_FAILURE: 500,
} as const;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function parseBody(raw: Uint8Array): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (raw.byteLength === 0) return { ok: true, value: {} };
  try {
    const v: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? { ok: true, value: v as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

/**
 * Human-facing application API (spec sections 41-42, S4 subset) and the minimal S4 workflow
 * proof pages. Routes only validate, build a command, call the operations service and map
 * typed errors to HTTP; no lifecycle rule lives here.
 *
 * DEVELOPMENT-ONLY IDENTITY: the actor comes from the `X-Demo-Actor-Id` header (or `?actor=` for
 * the HTML pages), is looked up in the server-side directory, and the organization and facility
 * scope come from that directory, never from the request. This is not authentication and must
 * be replaced by Firebase identity before any non-local use (S9).
 */
export function createAppHandler(
  deps: AppApiDeps,
): (request: EdgeRequest) => Promise<EdgeResponse> {
  const identity: IdentityResolver =
    deps.identity ?? new DemoHeaderIdentityResolver(deps.directory);

  async function actorFor(
    request: EdgeRequest,
    query: URLSearchParams,
  ): Promise<ActorContext | undefined> {
    return identity.resolve({
      headers: request.headers,
      // `?actor=` exists only for the local HTML proof pages; no other resolver sees it.
      ...(identity.kind === "demo" && { query }),
    });
  }

  /** Evidence and sharing facts for the case page; absent when the role may not read evidence. */
  async function caseExtras(
    actor: ActorContext,
    caseId: string,
    latestId: string | undefined,
  ): Promise<CaseEvidenceExtras | undefined> {
    if (!can(actor, "EVIDENCE_READ")) return undefined;
    const list = await deps.evidence.listForCase(actor, caseId);
    const agreements = await deps.sharing.listForCase(actor, caseId);
    if (!list.ok) return undefined;
    const latest =
      latestId === undefined ? undefined : await deps.evidence.getForActor(actor, latestId);
    const p = latest?.ok ? latest.value : undefined;
    return {
      packages: list.value.map((r) => ({
        packageId: r.packageId,
        createdAt: r.createdAt,
        resultLabel: RESULT_LABELS[r.result],
      })),
      ...(p !== undefined && {
        latest: {
          packageId: p.record.packageId,
          resultLabel: RESULT_LABELS[p.record.result],
          policyId: p.package.payload.verification.policyId,
          policyVersion: p.package.payload.verification.policyVersion,
          createdAt: p.record.createdAt,
          payloadSha256: p.record.payloadSha256,
          manifestSha256: p.record.manifestSha256,
          integrityValid: p.integrity.valid,
          integrityIssues: p.integrity.issues,
          sourceLabel: p.package.payload.source.label,
          synthetic: p.package.payload.source.synthetic,
        },
      }),
      agreements: agreements.ok
        ? agreements.value.map((g) => ({
            agreementId: g.agreement.agreementId,
            recipientOrganizationId: g.agreement.recipientOrganizationId,
            scopes: g.agreement.scopes,
            status: g.status,
            effectiveFrom: g.agreement.effectiveFrom,
            ...(g.agreement.expiresAt !== undefined && { expiresAt: g.agreement.expiresAt }),
            ...(g.agreement.revokedAt !== undefined && { revokedAt: g.agreement.revokedAt }),
          }))
        : [],
      canManageSharing: can(actor, "SHARING_MANAGE"),
      canGrantRaw: can(actor, "SHARING_GRANT_RAW_TELEMETRY"),
      standardScopes: EVIDENCE_CONSENT_SCOPES,
    };
  }

  /** Minimal UI form posts (grant / revoke). Same local identity; redirects back to the case. */
  async function uiPost(
    actor: ActorContext,
    parts: string[],
    query: URLSearchParams,
    request: EdgeRequest,
  ): Promise<EdgeResponse> {
    const html = (status: number, body: string): EdgeResponse => ({
      status,
      contentType: "text/html; charset=utf-8",
      body,
    });
    const caseId = query.get("case") ?? "";
    if (!ID.test(caseId)) return html(400, renderErrorHtml(400, "A case is required"));
    const back: EdgeResponse = {
      status: 303,
      contentType: "text/html; charset=utf-8",
      body: "",
      headers: { Location: `/ui/cases/${caseId}?actor=${encodeURIComponent(actor.actorId)}` },
    };
    const form = new URLSearchParams(new TextDecoder().decode(request.rawBody));
    if (parts[1] === "sharing" && parts[2] === "grant" && parts.length === 3) {
      const expires = form.get("expiresAt")?.trim() ?? "";
      const r = await deps.sharing.createAgreement(actor, {
        recipientOrganizationId: form.get("recipientOrganizationId") ?? "",
        scopes: form.getAll("scope"),
        facilityIds: [form.get("facilityId") ?? ""],
        ...(expires !== "" && { expiresAt: expires }),
      });
      return r.ok
        ? back
        : html(
            STATUS[r.error.code],
            renderErrorHtml(
              STATUS[r.error.code],
              `${r.error.message} ${(r.error.details ?? []).join(", ")}`,
            ),
          );
    }
    if (
      parts[1] === "sharing" &&
      parts[3] === "revoke" &&
      parts.length === 4 &&
      ID.test(parts[2] ?? "")
    ) {
      const r = await deps.sharing.revokeAgreement(actor, parts[2] as string);
      return r.ok
        ? back
        : html(STATUS[r.error.code], renderErrorHtml(STATUS[r.error.code], r.error.message));
    }
    return html(404, renderErrorHtml(404, "Not found"));
  }

  return async (request) => {
    const [path = "", queryString = ""] = request.target.split("?");
    const query = new URLSearchParams(queryString);
    const method = request.method.toUpperCase();
    const isUi = path.startsWith("/ui/");
    // The proof pages identify the caller from the URL; only the local demo resolver allows that.
    if (isUi && identity.kind !== "demo") return problem(404, "NOT_FOUND", "Unknown route");

    if (
      method === "GET" &&
      path === "/api/v1/dev/identities" &&
      deps.devIdentities !== undefined &&
      identity.kind === "demo"
    ) {
      const { actors, organizations } = deps.devIdentities;
      return json(200, {
        identity: "DEVELOPMENT_ONLY",
        actors: actors.map((a) => ({
          actorId: a.actorId,
          organizationId: a.organizationId,
          facilityIds: a.facilityIds,
          roles: a.roles,
          permissions: permissionsFor(a.roles),
        })),
        organizations,
      });
    }

    const actor = await actorFor(request, query);
    if (actor === undefined) {
      const message =
        identity.kind === "demo"
          ? "A known development actor is required (X-Demo-Actor-Id header or ?actor=)"
          : "A valid identity token is required (Authorization: Bearer)";
      return isUi
        ? {
            status: 401,
            contentType: "text/html; charset=utf-8",
            body: renderErrorHtml(401, message),
          }
        : problem(401, "UNAUTHENTICATED", message);
    }

    const parts = path.split("/").filter(Boolean); // e.g. ["api","v1","cases",":id","acknowledge"]

    if (isUi) {
      // The pages are read-only except the two sharing forms (grant / revoke).
      if (method === "POST" && parts[1] === "sharing") return uiPost(actor, parts, query, request);
      if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "UI pages are read-only");
      const html = (status: number, body: string): EdgeResponse => ({
        status,
        contentType: "text/html; charset=utf-8",
        body,
      });
      if (parts[1] === "cases" && parts.length === 2) {
        const r = await deps.operations.listCases(actor);
        return r.ok
          ? html(200, renderCaseListHtml(r.value, actor.actorId))
          : html(STATUS[r.error.code], renderErrorHtml(STATUS[r.error.code], r.error.message));
      }
      if (parts[1] === "cases" && parts.length === 3 && ID.test(parts[2] ?? "")) {
        const r = await deps.operations.getCaseView(actor, parts[2] as string);
        if (!r.ok) {
          return html(STATUS[r.error.code], renderErrorHtml(STATUS[r.error.code], r.error.message));
        }
        const extras = await caseExtras(
          actor,
          r.value.caseId,
          r.value.evidence.latestEvidencePackageId,
        );
        return html(200, renderCaseHtml(r.value, actor.actorId, extras));
      }
      if (parts[1] === "insurer" && parts[2] === "cases") {
        if (parts.length === 3) {
          const sites = await deps.insurance.sites(actor);
          if (!sites.ok) {
            return html(
              STATUS_FOR_INSURANCE[sites.error.code],
              renderErrorHtml(STATUS_FOR_INSURANCE[sites.error.code], sites.error.message),
            );
          }
          const cases = [];
          for (const s of sites.value) {
            const c = await deps.insurance.casesForSite(actor, s.siteId);
            if (c.ok) cases.push(...c.value);
          }
          return html(200, renderInsurerHomeHtml(actor.actorId, sites.value, cases));
        }
        if (parts.length === 4 && ID.test(parts[3] ?? "")) {
          const r = await deps.insurance.evidence(actor, parts[3] as string);
          return r.ok
            ? html(200, renderInsurerCaseHtml(actor.actorId, r.value))
            : html(
                STATUS_FOR_INSURANCE[r.error.code],
                renderErrorHtml(
                  STATUS_FOR_INSURANCE[r.error.code],
                  `${r.error.message}${r.error.reason !== undefined ? ` (${r.error.reason})` : ""}`,
                ),
              );
        }
      }
      return html(404, renderErrorHtml(404, "Not found"));
    }

    if (parts[0] !== "api" || parts[1] !== "v1") return problem(404, "NOT_FOUND", "Unknown route");
    const route = parts.slice(2);

    if (method === "GET" && route.length === 1 && route[0] === "me") {
      return json(200, {
        actorId: actor.actorId,
        organizationId: actor.organizationId,
        facilityIds: actor.facilityIds,
        roles: actor.roles,
        permissions: permissionsFor(actor.roles),
        identity: identity.kind === "demo" ? "DEVELOPMENT_ONLY" : "VERIFIED_TOKEN",
      });
    }
    if (method === "GET" && route.length === 1 && route[0] === "cases") {
      const r = await deps.operations.listCases(actor);
      return r.ok ? json(200, { cases: r.value }) : fromError(r.error);
    }

    if (route[0] === "ops" && route[1] === "tick" && route.length === 2) {
      if (method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", "POST only");
      if (deps.runTick === undefined) return problem(404, "NOT_FOUND", "Unknown route");
      if (!can(actor, "OPS_TICK")) return problem(403, "FORBIDDEN", "Missing permission OPS_TICK");
      return json(200, await deps.runTick());
    }

    // ---- verifications and intervention recommendations (S5) -----------------------------
    if (route[0] === "verifications" && route.length === 2 && ID.test(route[1] ?? "")) {
      if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
      const r = await deps.operations.getVerification(actor, route[1] as string);
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (route[0] === "interventions") {
      if (route.length === 1) {
        if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
        const r = await deps.interventions.list(actor);
        return r.ok ? json(200, { interventions: r.value }) : fromInterventionError(r.error);
      }
      if (ID.test(route[1] ?? "")) {
        const id = route[1] as string;
        if (route.length === 2) {
          if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
          const r = await deps.interventions.get(actor, id);
          return r.ok ? json(200, r.value) : fromInterventionError(r.error);
        }
        if (route.length === 3 && route[2] === "acknowledge") {
          if (method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", "POST only");
          const r = await deps.interventions.acknowledge(actor, id);
          return r.ok ? json(200, r.value) : fromInterventionError(r.error);
        }
      }
      return problem(404, "NOT_FOUND", "Unknown route");
    }

    // ---- evidence and sharing (S6) -------------------------------------------------------------
    if (route[0] === "evidence" && route.length === 2 && ID.test(route[1] ?? "")) {
      if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
      const r = await deps.evidence.getForActor(actor, route[1] as string);
      return r.ok
        ? json(200, {
            record: r.value.record,
            integrity: r.value.integrity,
            package: r.value.package,
          })
        : fromEvidenceError(r.error);
    }
    if (route[0] === "sharing-agreements") {
      if (route.length === 1) {
        if (method === "GET") {
          const r = await deps.sharing.listAgreements(actor);
          return r.ok ? json(200, { agreements: r.value }) : fromConsentError(r.error);
        }
        if (method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", "GET or POST only");
        const body = parseBody(request.rawBody);
        if (!body.ok) return problem(400, "MALFORMED_BODY", "Body must be a JSON object");
        // The granting organization is the actor's own and is never read from the body.
        const r = await deps.sharing.createAgreement(actor, {
          recipientOrganizationId: body.value.recipientOrganizationId,
          scopes: body.value.scopes,
          facilityIds: body.value.facilityIds,
          effectiveFrom: body.value.effectiveFrom,
          expiresAt: body.value.expiresAt,
        });
        return r.ok ? json(201, r.value) : fromConsentError(r.error);
      }
      if (ID.test(route[1] ?? "")) {
        const id = route[1] as string;
        if (route.length === 2) {
          if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
          const r = await deps.sharing.getAgreement(actor, id);
          return r.ok ? json(200, r.value) : fromConsentError(r.error);
        }
        if (route.length === 3 && route[2] === "revoke") {
          if (method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", "POST only");
          const body = parseBody(request.rawBody);
          if (!body.ok) return problem(400, "MALFORMED_BODY", "Body must be a JSON object");
          const r = await deps.sharing.revokeAgreement(actor, id, body.value.reason);
          return r.ok ? json(200, r.value) : fromConsentError(r.error);
        }
      }
      return problem(404, "NOT_FOUND", "Unknown route");
    }

    if (route[0] !== "cases" || route.length < 2 || !ID.test(route[1] ?? "")) {
      return problem(404, "NOT_FOUND", "Unknown route");
    }
    const caseId = route[1] as string;

    if (route.length === 3 && route[2] === "explanation") {
      if (method !== "GET") return problem(405, "METHOD_NOT_ALLOWED", "GET only");
      if (deps.explanations === undefined) return problem(404, "NOT_FOUND", "Unknown route");
      // Same authorization and tenant scoping as the case page: the facts come from the case view.
      const view = await deps.operations.getCaseView(actor, caseId);
      if (!view.ok) return fromError(view.error);
      let evidence: EvidenceInput | undefined;
      const pkgId = view.value.evidence.latestEvidencePackageId;
      if (pkgId !== undefined && can(actor, "EVIDENCE_READ")) {
        const e = await deps.evidence.getForActor(actor, pkgId);
        if (e.ok) {
          evidence = {
            packageId: e.value.record.packageId,
            createdAt: e.value.record.createdAt,
            integrity: e.value.integrity.valid ? "PASSED" : "FAILED",
            synthetic: e.value.package.payload.source.synthetic,
            sourceLabel: e.value.package.payload.source.label,
            artifactCount: e.value.package.manifest.artifacts.length,
          };
        }
      }
      const out = await deps.explanations.explain(buildFacilityContext(view.value, evidence), {
        actorId: actor.actorId,
      });
      return json(200, out);
    }

    if (method === "GET" && route.length === 2) {
      const r = await deps.operations.getCaseView(actor, caseId);
      if (!r.ok) return fromError(r.error);
      const packages = await deps.evidence.listForCase(actor, caseId);
      const agreements = await deps.sharing.listForCase(actor, caseId);
      return json(200, {
        ...r.value,
        ...(packages.ok && { evidencePackages: packages.value }),
        ...(agreements.ok && { sharingAgreements: agreements.value }),
      });
    }
    if (method !== "POST") return problem(405, "METHOD_NOT_ALLOWED", "Unsupported method");

    const body = parseBody(request.rawBody);
    if (!body.ok) return problem(400, "MALFORMED_BODY", "Body must be a JSON object");
    const b = body.value;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);

    if (route.length === 3 && route[2] === "acknowledge") {
      const r = await deps.operations.acknowledgeCase(actor, caseId, str(b.note));
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (route.length === 3 && route[2] === "assignments") {
      const r = await deps.operations.assignAction(actor, caseId, {
        actionLibraryId: str(b.actionLibraryId) ?? "",
        assigneeId: str(b.assigneeId) ?? "",
      });
      return r.ok ? json(201, r.value) : fromError(r.error);
    }
    if (route.length === 3 && route[2] === "actions") {
      const attachments = b.attachments;
      const r = await deps.operations.reportAction(actor, caseId, {
        actionLibraryId: str(b.actionLibraryId) ?? "",
        ...(str(b.actionId) !== undefined && { actionId: str(b.actionId) as string }),
        ...(b.notes !== undefined && { notes: b.notes as string }),
        ...(attachments !== undefined && { attachments: attachments as string[] }),
      });
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (
      route.length === 5 &&
      route[2] === "actions" &&
      route[4] === "acknowledge" &&
      ID.test(route[3] ?? "")
    ) {
      const r = await deps.operations.acknowledgeAction(actor, caseId, route[3] as string);
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (route.length === 3 && route[2] === "dismiss") {
      const r = await deps.operations.dismissCase(actor, caseId, str(b.reason) ?? "");
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    return problem(404, "NOT_FOUND", "Unknown route");
  };
}

/** Routes by path: signed device traffic vs. human-facing API/UI. */
export function createApiHandler(handlers: {
  readonly edge: (request: EdgeRequest) => Promise<EdgeResponse>;
  readonly app: (request: EdgeRequest) => Promise<EdgeResponse>;
  readonly insurance: (request: EdgeRequest) => Promise<EdgeResponse>;
}): (request: EdgeRequest) => Promise<EdgeResponse> {
  return (request) =>
    request.target.startsWith("/insurance/")
      ? handlers.insurance(request)
      : request.target.startsWith("/api/") || request.target.startsWith("/ui/")
        ? handlers.app(request)
        : handlers.edge(request);
}
