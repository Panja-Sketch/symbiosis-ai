import type { ApiProblem } from "./sim-types";

/**
 * Browser-side calls for the Facility Simulation workspace. They go to this web app's own
 * `/sim-api/...` proxy (never to the backend), carrying a request marker the proxy requires on every
 * write. A failed call is returned as a problem to show in words; it is never thrown.
 */
export type SimResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ApiProblem };

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<SimResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/sim-api/${path}`, {
      method,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...(method === "POST" && { "Content-Type": "application/json", "X-Symbiosis-Sim": "1" }),
      },
      ...(method === "POST" && { body: JSON.stringify(body ?? {}) }),
    });
  } catch {
    return {
      ok: false,
      problem: { status: 0, code: "OFFLINE", message: "The connection to the server was lost." },
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
    problem: {
      status: res.status,
      code: typeof e?.code === "string" ? e.code : "ERROR",
      message: typeof e?.message === "string" ? e.message : `The server answered ${res.status}.`,
      ...(Array.isArray(e?.issues) && { issues: e.issues as string[] }),
    },
  };
}

export const simGet = <T>(path: string) => call<T>("GET", path);
export const simPost = <T>(path: string, body?: unknown) => call<T>("POST", path, body);

export const problemText = (p: ApiProblem): string =>
  [p.message, ...(p.issues ?? [])].filter((x) => x !== "").join(" ");
