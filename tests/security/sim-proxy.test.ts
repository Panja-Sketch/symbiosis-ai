import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The browser fetch allow-list admits `lib/sim-client.ts` only because `/sim-api` is a controlled
 * same-origin proxy (D-093). These tests drive the real route handler and prove it cannot be used to
 * reach another route, host, header or identity: it fails closed.
 */
const cookieJar = new Map<string, string>();
vi.mock("../../apps/web/node_modules/next/headers.js", () => ({
  cookies: async () => ({
    get: (n: string) => (cookieJar.has(n) ? { value: cookieJar.get(n) } : undefined),
  }),
}));

type Route = typeof import("../../apps/web/src/app/sim-api/[...path]/route");
let route: Route;
let upstream: ReturnType<typeof vi.fn>;

const ctx = (path: string[]) => ({ params: Promise.resolve({ path }) });
const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`http://web.test/sim-api/${path}`, {
      method: "POST",
      headers: { "x-symbiosis-sim": "1", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    ctx(path.split("/")),
  );
const get = (path: string, search = "") =>
  route.GET(new Request(`http://web.test/sim-api/${path}${search}`), ctx(path.split("/")));

beforeEach(async () => {
  cookieJar.clear();
  cookieJar.set("symbiosis_demo_actor", "USR-FACILITY-MGR-001");
  process.env.SYMBIOSIS_API_URL = "http://api.internal:8787";
  delete process.env.SYMBIOSIS_AUTH_MODE;
  upstream = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", upstream);
  route = await import("../../apps/web/src/app/sim-api/[...path]/route");
});
afterEach(() => vi.unstubAllGlobals());

describe("/sim-api proxy", () => {
  it("forwards an allow-listed call to the fixed API origin as the cookie identity only", async () => {
    const res = await get("simulation");
    expect(res.status).toBe(200);
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal:8787/api/v1/simulation");
    expect(init.headers).toEqual({ "X-Demo-Actor-Id": "USR-FACILITY-MGR-001" });
  });

  it("never forwards caller headers or a caller-chosen identity", async () => {
    await post(
      "simulation/pulse",
      {},
      {
        "x-demo-actor-id": "USR-ORG-ADMIN-001",
        authorization: "Bearer attacker",
        host: "evil.example",
      },
    );
    const [, init] = upstream.mock.calls[0] as [string, RequestInit];
    const h = init.headers as Record<string, string>;
    expect(h["X-Demo-Actor-Id"]).toBe("USR-FACILITY-MGR-001");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain("host");
  });

  it.each([
    ["simulation/../../insurance/v1/sites"],
    ["insurance/v1/sites"],
    ["me"],
    ["ops/tick"],
    ["dev/identities"],
    ["sharing-agreements/x/y"],
    ["simulation/unknown"],
    ["cases/.."],
    ["cases/../acknowledge"],
    ["evidence/.."],
    ["http:/evil.example/x"],
  ])("returns 404 and calls nothing for %s", async (p) => {
    const res = await post(p);
    expect(res.status).toBe(404);
    expect((await get(p)).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects the wrong method for a route", async () => {
    expect((await get("simulation/reset")).status).toBe(404);
    const res = await route.POST(
      new Request("http://web.test/sim-api/simulation", {
        method: "POST",
        headers: { "x-symbiosis-sim": "1" },
        body: "{}",
      }),
      ctx(["simulation"]),
    );
    expect(res.status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("requires the request marker on every write (cross-site form posts are refused)", async () => {
    const res = await route.POST(
      new Request("http://web.test/sim-api/simulation/reset", { method: "POST", body: "{}" }),
      ctx(["simulation", "reset"]),
    );
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("is unauthenticated without an identity cookie and calls nothing", async () => {
    cookieJar.clear();
    expect((await get("simulation")).status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses oversized and malformed bodies", async () => {
    const big = await post("simulation/state", { x: "a".repeat(40_000) });
    expect(big.status).toBe(413);
    const bad = await route.POST(
      new Request("http://web.test/sim-api/simulation/state", {
        method: "POST",
        headers: { "x-symbiosis-sim": "1" },
        body: "{not json",
      }),
      ctx(["simulation", "state"]),
    );
    expect(bad.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("passes only a short, safe query string", async () => {
    await get("simulation/timeline", "?after=12");
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      "http://api.internal:8787/api/v1/simulation/timeline?after=12",
    );
    upstream.mockClear();
    await get("simulation/timeline", "?after=1&evil=../../x%00");
    expect((upstream.mock.calls[0] as [string])[0]).toBe(
      "http://api.internal:8787/api/v1/simulation/timeline",
    );
  });

  it("relays the API's denial status instead of widening it", async () => {
    upstream.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "no" } }), {
        status: 403,
      }),
    );
    const res = await get("simulation");
    expect(res.status).toBe(403);
  });
});
