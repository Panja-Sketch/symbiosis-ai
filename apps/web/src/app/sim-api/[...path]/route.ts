import { cookies } from "next/headers";
import { apiCall } from "../../../lib/api";
import { authMode } from "../../../lib/auth-mode";
import { IDENTITY_COOKIE } from "../../../lib/identity";

/**
 * Same-origin proxy for the Facility Simulation workspace (D-093). The browser never talks to the
 * backend directly: it calls `/sim-api/<path>` here, and this server forwards ONE allow-listed call
 * to `/api/v1/<path>` as the signed-in identity. The allow-list is deliberately small: the
 * simulation routes, reading a case, the human case commands (acknowledge, assign, report), reading
 * an evidence package, and the customer's own sharing grant and revoke. Nothing here decides
 * anything; the API authorizes and applies every rule.
 */
const ROUTES: readonly { readonly method: "GET" | "POST"; readonly pattern: RegExp }[] = [
  {
    method: "GET",
    pattern: /^simulation(\/(timeline|series|policy|adapters|adapters\/compare))?$/,
  },
  {
    method: "POST",
    pattern:
      /^simulation\/(session\/(start|stop)|scenario|state|weather|pulse|tick|reset|policy|policy\/activate|adapters\/(preview|validate|publish|activate))$/,
  },
  { method: "GET", pattern: /^cases\/[A-Za-z0-9_.:-]{1,128}$/ },
  {
    method: "POST",
    pattern: /^cases\/[A-Za-z0-9_.:-]{1,128}\/(acknowledge|assignments|actions)$/,
  },
  { method: "GET", pattern: /^evidence\/[A-Za-z0-9_.:-]{1,128}$/ },
  { method: "POST", pattern: /^sharing-agreements$/ },
  { method: "POST", pattern: /^sharing-agreements\/[A-Za-z0-9_.:-]{1,128}\/revoke$/ },
];

const MAX_BODY = 32 * 1024;

async function handle(request: Request, path: string[]): Promise<Response> {
  const method = request.method.toUpperCase();
  const joined = path.join("/");
  const url = new URL(request.url);
  if (!ROUTES.some((r) => r.method === method && r.pattern.test(joined))) {
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Unknown route" } },
      { status: 404 },
    );
  }
  if (method === "POST") {
    // A custom header cannot be sent cross-site without a CORS preflight, which this app never allows.
    if (request.headers.get("x-symbiosis-sim") !== "1") {
      return Response.json(
        { error: { code: "FORBIDDEN", message: "Missing request marker" } },
        { status: 403 },
      );
    }
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_BODY) {
      return Response.json(
        { error: { code: "TOO_LARGE", message: "Body too large" } },
        { status: 413 },
      );
    }
  }
  let body: unknown;
  if (method === "POST") {
    const text = await request.text();
    if (text.length > MAX_BODY) {
      return Response.json(
        { error: { code: "TOO_LARGE", message: "Body too large" } },
        { status: 413 },
      );
    }
    try {
      body = text === "" ? {} : JSON.parse(text);
    } catch {
      return Response.json(
        { error: { code: "INVALID_REQUEST", message: "Body is not JSON" } },
        { status: 400 },
      );
    }
  }
  const actorId =
    authMode() === "token" ? "session" : (await cookies()).get(IDENTITY_COOKIE)?.value;
  if (actorId === undefined || actorId === "") {
    return Response.json(
      { error: { code: "UNAUTHENTICATED", message: "Choose an identity" } },
      { status: 401 },
    );
  }
  const query =
    url.search.length > 0 && /^\?[A-Za-z0-9=&._-]{1,64}$/.test(url.search) ? url.search : "";
  const result = await apiCall<unknown>(`/api/v1/${joined}${query}`, {
    actorId,
    method,
    ...(body !== undefined && { body }),
  });
  if (result.ok) return Response.json(result.value, { headers: { "Cache-Control": "no-store" } });
  return Response.json(
    {
      error: {
        code: result.code,
        message: result.message,
        ...(result.details !== undefined && { issues: result.details }),
      },
    },
    { status: result.status === 0 ? 502 : result.status, headers: { "Cache-Control": "no-store" } },
  );
}

type Ctx = { params: Promise<{ path: string[] }> };
export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
export async function POST(request: Request, ctx: Ctx): Promise<Response> {
  return handle(request, (await ctx.params).path);
}
