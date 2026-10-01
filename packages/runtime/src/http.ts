import type { Logger } from "@symbiosis/adapter-gcp";
import type { EdgeRequest, EdgeResponse } from "@symbiosis/api";

export type Handler = (request: EdgeRequest) => Promise<EdgeResponse>;

export type Readiness = () => Promise<{
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, boolean>>;
}>;

/**
 * Liveness, readiness and version, answered before any application routing. None of them mutates
 * state or needs authentication, and none reveals configuration: `/livez` says the process is
 * up, `/readyz` says whether the critical adapters answer (503 otherwise, so a broken revision is
 * never sent traffic), `/version` names the build.
 */
export function withHealth(
  inner: Handler,
  options: { readonly role: string; readonly version: string; readonly readiness: Readiness },
): Handler {
  return async (request) => {
    if (request.method.toUpperCase() === "GET" || request.method.toUpperCase() === "HEAD") {
      const path = request.target.split("?")[0];
      if (path === "/livez") {
        return { status: 200, body: { status: "ok", role: options.role } };
      }
      if (path === "/readyz") {
        let result: Awaited<ReturnType<Readiness>>;
        try {
          result = await options.readiness();
        } catch {
          result = { ready: false, checks: {} };
        }
        return {
          status: result.ready ? 200 : 503,
          body: {
            status: result.ready ? "ready" : "not_ready",
            role: options.role,
            checks: result.checks,
          },
        };
      }
      if (path === "/version") {
        return { status: 200, body: { role: options.role, version: options.version } };
      }
    }
    return inner(request);
  };
}

const IDLIKE = /^[A-Za-z0-9_.:-]{1,128}$/;

/** One structured log line per request: method, path (never the query string), status, latency. */
export function withRequestLogging(inner: Handler, logger: Logger, component: string): Handler {
  return async (request) => {
    const started = Date.now();
    const path = (request.target.split("?")[0] ?? "").replace(/\/[^/]*\d[^/]*(?=\/|$)/g, (seg) =>
      IDLIKE.test(seg.slice(1)) ? "/:id" : seg,
    );
    try {
      const response = await inner(request);
      if (path !== "/livez" && path !== "/readyz") {
        logger.log(response.status >= 500 ? "ERROR" : "INFO", "request", {
          component,
          method: request.method,
          path,
          status: response.status,
          latencyMs: Date.now() - started,
        });
      }
      return response;
    } catch (e) {
      logger.log("ERROR", "request failed", {
        component,
        method: request.method,
        path,
        latencyMs: Date.now() - started,
        error: e,
      });
      throw e;
    }
  };
}
