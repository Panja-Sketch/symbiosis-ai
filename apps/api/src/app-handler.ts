import type { Operations, OperationsError } from "@symbiosis/action-orchestration";
import type {
  InterventionError,
  InterventionService,
} from "@symbiosis/intervention-prioritization";
import { can } from "@symbiosis/authz";
import { permissionsFor } from "@symbiosis/authz";
import type { ActorContext, ActorDirectory } from "@symbiosis/tenancy";
import type { EdgeRequest, EdgeResponse } from "./edge-handler";
import { renderCaseHtml, renderCaseListHtml, renderErrorHtml } from "./html";

export type AppApiDeps = {
  readonly operations: Operations;
  readonly interventions: InterventionService;
  readonly directory: ActorDirectory;
  /**
   * Local-only maintenance hook: runs the escalation evaluator and alert retries once. Absent
   * means the route does not exist. Cloud mode will use Cloud Scheduler instead (S9).
   */
  readonly runTick?: () => Promise<unknown>;
};

const STATUS: Record<OperationsError["code"], number> = {
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  INVALID_REQUEST: 400,
  CONFLICT: 409,
};

const fromInterventionError = (e: InterventionError): EdgeResponse =>
  json(STATUS[e.code], { error: { code: e.code, message: e.message } });

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
  async function actorFor(
    request: EdgeRequest,
    query: URLSearchParams,
  ): Promise<ActorContext | undefined> {
    const id = request.headers["x-demo-actor-id"] ?? query.get("actor") ?? undefined;
    return id === undefined || !ID.test(id) ? undefined : deps.directory.get(id);
  }

  return async (request) => {
    const [path = "", queryString = ""] = request.target.split("?");
    const query = new URLSearchParams(queryString);
    const method = request.method.toUpperCase();
    const isUi = path.startsWith("/ui/");

    const actor = await actorFor(request, query);
    if (actor === undefined) {
      const message = "A known development actor is required (X-Demo-Actor-Id header or ?actor=)";
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
        return r.ok
          ? html(200, renderCaseHtml(r.value, actor.actorId))
          : html(STATUS[r.error.code], renderErrorHtml(STATUS[r.error.code], r.error.message));
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
        identity: "DEVELOPMENT_ONLY",
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

    if (route[0] !== "cases" || route.length < 2 || !ID.test(route[1] ?? "")) {
      return problem(404, "NOT_FOUND", "Unknown route");
    }
    const caseId = route[1] as string;

    if (method === "GET" && route.length === 2) {
      const r = await deps.operations.getCaseView(actor, caseId);
      return r.ok ? json(200, r.value) : fromError(r.error);
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
}): (request: EdgeRequest) => Promise<EdgeResponse> {
  return (request) =>
    request.target.startsWith("/api/") || request.target.startsWith("/ui/")
      ? handlers.app(request)
      : handlers.edge(request);
}
