import { buildInsurerContext } from "@symbiosis/ai-explanation";
import type { ExplanationService } from "@symbiosis/ai-explanation";
import type { InsuranceError, InsuranceGateway } from "@symbiosis/consent";
import type { ActorContext, ActorDirectory } from "@symbiosis/tenancy";
import type { EdgeRequest, EdgeResponse } from "./edge-handler";

export type InsuranceApiDeps = {
  readonly gateway: InsuranceGateway;
  readonly directory: ActorDirectory;
  /** Optional explanation layer (S8): inputs are the consent-filtered projection only. */
  readonly explanations?: ExplanationService;
};

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const json = (status: number, body: unknown): EdgeResponse => ({ status, body });
const problem = (status: number, code: string, message: string, extra: object = {}): EdgeResponse =>
  json(status, { error: { code, message, ...extra } });

const STATUS: Record<InsuranceError["code"], number> = {
  FORBIDDEN: 403,
  ACCESS_DENIED: 403,
  NOT_FOUND: 404,
  INTEGRITY_FAILURE: 500,
  AUDIT_FAILURE: 500,
};

const fromError = (e: InsuranceError): EdgeResponse =>
  problem(STATUS[e.code], e.code, e.message, e.reason !== undefined ? { reason: e.reason } : {});

/**
 * Insurance Evidence API (spec 43). The caller is identified server-side from the development
 * directory (the same local identity as the application API); the recipient organization used
 * for every consent decision is that actor's own, never a value from the request. Each route only
 * calls the consent-filtered gateway: there is no route that reads cases, packages or telemetry
 * directly. DEVELOPMENT-ONLY identity; real identity is S9.
 */
export function createInsuranceHandler(
  deps: InsuranceApiDeps,
): (request: EdgeRequest) => Promise<EdgeResponse> {
  async function actorFor(request: EdgeRequest): Promise<ActorContext | undefined> {
    const id = request.headers["x-demo-actor-id"];
    return id === undefined || !ID.test(id) ? undefined : deps.directory.get(id);
  }

  return async (request) => {
    const [path = "", queryString = ""] = request.target.split("?");
    const query = new URLSearchParams(queryString);
    const actor = await actorFor(request);
    if (actor === undefined) {
      return problem(
        401,
        "UNAUTHENTICATED",
        "A known development actor is required (X-Demo-Actor-Id)",
      );
    }
    if (request.method.toUpperCase() !== "GET") {
      return problem(405, "METHOD_NOT_ALLOWED", "The insurance evidence API is read-only");
    }
    const parts = path.split("/").filter(Boolean); // insurance v1 ...
    if (parts[0] !== "insurance" || parts[1] !== "v1") {
      return problem(404, "NOT_FOUND", "Unknown route");
    }
    const route = parts.slice(2);

    if (route.length === 1 && route[0] === "sites") {
      const r = await deps.gateway.sites(actor);
      return r.ok ? json(200, { sites: r.value }) : fromError(r.error);
    }
    if (
      route.length === 3 &&
      route[0] === "sites" &&
      route[2] === "cases" &&
      ID.test(route[1] ?? "")
    ) {
      const r = await deps.gateway.casesForSite(actor, route[1] as string);
      return r.ok ? json(200, { cases: r.value }) : fromError(r.error);
    }
    if (route.length === 2 && route[0] === "cases" && ID.test(route[1] ?? "")) {
      const r = await deps.gateway.caseView(actor, route[1] as string);
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (
      route.length === 3 &&
      route[0] === "cases" &&
      route[2] === "evidence" &&
      ID.test(route[1] ?? "")
    ) {
      const include = query.get("include");
      if (include !== null && include !== "raw_telemetry") {
        return problem(400, "INVALID_REQUEST", "include must be raw_telemetry when present");
      }
      const packageId = query.get("package");
      if (packageId !== null && !ID.test(packageId)) {
        return problem(400, "INVALID_REQUEST", "package is not a valid id");
      }
      const r = await deps.gateway.evidence(actor, route[1] as string, {
        ...(packageId !== null && { packageId }),
        includeRawTelemetry: include === "raw_telemetry",
      });
      return r.ok ? json(200, r.value) : fromError(r.error);
    }
    if (
      route.length === 3 &&
      route[0] === "cases" &&
      route[2] === "explanation" &&
      ID.test(route[1] ?? "")
    ) {
      if (deps.explanations === undefined) return problem(404, "NOT_FOUND", "Unknown route");
      const caseId = route[1] as string;
      // Consent is re-checked (and the read audited) by the gateway on every request; the
      // explanation is built ONLY from what it releases, never from an internal API.
      const view = await deps.gateway.caseView(actor, caseId);
      if (!view.ok) return fromError(view.error);
      const ints = await deps.gateway.interventions(actor);
      const current = ints.ok
        ? ints.value.find(
            (x) => x.caseId === caseId && x.status !== "SUPERSEDED" && x.status !== "RESOLVED",
          )
        : undefined;
      const out = await deps.explanations.explain(buildInsurerContext(view.value, current), {
        actorId: actor.actorId,
      });
      return json(200, out);
    }
    if (route.length === 1 && route[0] === "recommendations") {
      const r = await deps.gateway.recommendations(actor);
      return r.ok ? json(200, { recommendations: r.value }) : fromError(r.error);
    }
    if (route.length === 1 && route[0] === "interventions") {
      const r = await deps.gateway.interventions(actor);
      return r.ok ? json(200, { interventions: r.value }) : fromError(r.error);
    }
    return problem(404, "NOT_FOUND", "Unknown route");
  };
}
