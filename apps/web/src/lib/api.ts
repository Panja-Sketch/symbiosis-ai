/**
 * The ONLY door from the web app to the backend: HTTP calls to `/api/v1` (facility) and
 * `/insurance/v1` (insurer). It runs on the Next.js server; the browser never talks to the API
 * and no repository or domain package is imported anywhere in `apps/web`.
 *
 * Every call carries the development identity as `X-Demo-Actor-Id`. The server maps that id to an
 * organization, facilities and roles itself, so nothing the web app sends can widen a scope.
 */
import { cookies } from "next/headers";
import { SESSION_COOKIE, authMode } from "./auth-mode";

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

type Init = {
  readonly actorId?: string;
  readonly body?: unknown;
  readonly method?: string;
  /** An explicit ID token (used once, to check a fresh sign-in before a session is stored). */
  readonly bearer?: string;
};

/**
 * Who the call is made as. Demo mode: the development actor id header. Token mode (cloud): the
 * person's ID token from the HttpOnly session cookie, as a bearer token; the API verifies it and
 * derives organization, facilities and roles itself, so no id supplied here can widen access.
 */
async function identityHeaders(init: Init): Promise<Record<string, string>> {
  if (init.bearer !== undefined) return { Authorization: `Bearer ${init.bearer}` };
  if (authMode() === "token") {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    return token === undefined || token === "" ? {} : { Authorization: `Bearer ${token}` };
  }
  return init.actorId !== undefined ? { "X-Demo-Actor-Id": init.actorId } : {};
}

/** One fetch; a GET is retried once on a network error (a pooled connection to a restarted API). */
async function send(path: string, init: Init): Promise<Response> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const identity = await identityHeaders(init);
  const attempt = () =>
    fetch(`${apiBaseUrl()}${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...identity,
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

/** The API's view of a freshly signed-in person (also proves the token is valid). */
export const apiMe = (bearer: string) => apiCall<{ actorId: string }>("/api/v1/me", { bearer });
