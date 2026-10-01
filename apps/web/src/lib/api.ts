/**
 * The ONLY door from the web app to the backend: HTTP calls to `/api/v1` (facility) and
 * `/insurance/v1` (insurer). It runs on the Next.js server; the browser never talks to the API
 * and no repository or domain package is imported anywhere in `apps/web`.
 *
 * Every call carries the development identity as `X-Demo-Actor-Id`. The server maps that id to an
 * organization, facilities and roles itself, so nothing the web app sends can widen a scope.
 */
/** Read per call so tests and deployments can point the web server at any API. */
export const apiBaseUrl = (): string =>
  (process.env.SYMBIOSIS_API_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

export type ApiError = {
  readonly ok: false;
  /** HTTP status; 0 when the API could not be reached. */
  readonly status: number;
  readonly code: string;
  readonly message: string;
  /** Consent denial reason (insurer API) or domain detail. */
  readonly reason?: string;
  readonly details?: readonly string[];
};
export type ApiResult<T> = { readonly ok: true; readonly value: T } | ApiError;

type Init = { readonly actorId?: string; readonly body?: unknown; readonly method?: string };

/** One fetch; a GET is retried once on a network error (a pooled connection to a restarted API). */
async function send(path: string, init: Init): Promise<Response> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const attempt = () =>
    fetch(`${apiBaseUrl()}${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(init.actorId !== undefined && { "X-Demo-Actor-Id": init.actorId }),
        ...(init.body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    });
  if (method !== "GET") return attempt();
  try {
    return await attempt();
  } catch {
    return attempt();
  }
}

export async function apiCall<T>(path: string, init: Init = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await send(path, init);
  } catch {
    return {
      ok: false,
      status: 0,
      code: "API_UNREACHABLE",
      message: "The Symbiosis API could not be reached. Start it with `pnpm dev` and retry.",
    };
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  if (res.ok) return { ok: true, value: json as T };
  const e = (json as { error?: Record<string, unknown> } | undefined)?.error;
  return {
    ok: false,
    status: res.status,
    code: typeof e?.code === "string" ? e.code : "ERROR",
    message: typeof e?.message === "string" ? e.message : `The API answered ${res.status}.`,
    ...(typeof e?.reason === "string" && { reason: e.reason }),
    ...(Array.isArray(e?.details) && { details: e.details as string[] }),
  };
}

export const apiGet = <T>(actorId: string | undefined, path: string) =>
  apiCall<T>(path, { ...(actorId !== undefined && { actorId }) });

export const apiPost = <T>(actorId: string, path: string, body: unknown = {}) =>
  apiCall<T>(path, { actorId, body });
