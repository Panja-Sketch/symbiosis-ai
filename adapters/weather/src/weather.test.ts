import { describe, expect, it } from "vitest";
import type { WeatherReading, WeatherResult } from "@symbiosis/contracts";
import { InMemoryAuditLog } from "@symbiosis/audit";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryDeviceRegistry, createEdgeDeviceRecord } from "@symbiosis/device-registry";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import { GoogleWeatherProvider } from "./google";
import { createWeatherService } from "./service";
import type { WeatherPolicy } from "./service";
import { ScriptedWeatherProvider, SimulatedWeatherProvider } from "./simulated";

const T0 = Date.parse("2026-10-02T18:00:00.000Z");
const loc = { latitude: 33.4484, longitude: -112.074 };

const goodBody = (over: Record<string, unknown> = {}) => ({
  currentTime: "2026-10-02T17:58:00Z",
  temperature: { degrees: 41.2, unit: "CELSIUS" },
  relativeHumidity: 12,
  weatherCondition: { description: { text: "Sunny", languageCode: "en" } },
  wind: { speed: { value: 10, unit: "MILES_PER_HOUR" } },
  ...over,
});

function fakeFetch(
  responder: (url: string, init: RequestInit) => Promise<Response> | Response,
  calls: { url: string; headers: Record<string, string> }[] = [],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init.headers as Record<string, string>) } });
    return responder(String(url), init);
  }) as unknown as typeof fetch;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(responder: Parameters<typeof fakeFetch>[0], over: { timeoutMs?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const clock = new ManualClock(T0);
  const p = new GoogleWeatherProvider({
    clock,
    fetchImpl: fakeFetch(responder, calls),
    authHeaders: async () => ({ "X-Goog-Api-Key": "SECRET-KEY-VALUE" }),
    ...over,
  });
  return { p, calls, clock };
}

describe("GoogleWeatherProvider", () => {
  it("reads current conditions and keeps the provider's own observation time", async () => {
    const { p, calls } = provider(() => json(goodBody()));
    const r = await p.current(loc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading).toMatchObject({
      provider: "GOOGLE_WEATHER",
      live: true,
      observedAt: "2026-10-02T17:58:00.000Z",
      fetchedAt: "2026-10-02T18:00:00.000Z",
      temperatureC: 41.2,
      relativeHumidityPct: 12,
      condition: "Sunny",
      windSpeedKph: 16.1,
    });
    // The key travels in a header, never in the URL.
    expect(calls[0]?.url).not.toMatch(/key|SECRET/i);
    expect(calls[0]?.url).toContain("location.latitude=33.4484");
    expect(calls[0]?.headers["X-Goog-Api-Key"]).toBe("SECRET-KEY-VALUE");
  });

  it("converts Fahrenheit and rejects unknown temperature units", async () => {
    const f = await provider(() =>
      json(goodBody({ temperature: { degrees: 108, unit: "FAHRENHEIT" } })),
    ).p.current(loc);
    expect(f.ok && f.reading.temperatureC).toBeCloseTo(42.22, 2);
    const k = await provider(() =>
      json(goodBody({ temperature: { degrees: 300, unit: "KELVIN" } })),
    ).p.current(loc);
    expect(k).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
  });

  it("never invents an observation time or a temperature", async () => {
    for (const body of [
      goodBody({ currentTime: undefined }),
      goodBody({ currentTime: "not a time" }),
      goodBody({ temperature: undefined }),
      goodBody({ temperature: { degrees: "hot", unit: "CELSIUS" } }),
      goodBody({ temperature: { degrees: 900, unit: "CELSIUS" } }),
      goodBody({ currentTime: "2027-01-01T00:00:00Z" }),
      [],
      "text",
    ]) {
      const r = await provider(() => json(body)).p.current(loc);
      expect(r, JSON.stringify(body)).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
    }
  });

  it("ignores out-of-range display fields instead of failing the temperature", async () => {
    const r = await provider(() =>
      json(
        goodBody({ relativeHumidity: 400, wind: { speed: { value: -3, unit: "MILES_PER_HOUR" } } }),
      ),
    ).p.current(loc);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.reading.relativeHumidityPct).toBeUndefined();
      expect(r.reading.windSpeedKph).toBeUndefined();
    }
  });

  it("reports HTTP errors, non-JSON, oversized bodies and network failures without leaking detail", async () => {
    expect(
      await provider(() => json({ error: "key SECRET-KEY-VALUE bad" }, 403)).p.current(loc),
    ).toEqual({
      ok: false,
      code: "HTTP_ERROR",
      message: "weather provider answered 403",
    });
    expect(await provider(() => new Response("<html>")).p.current(loc)).toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(await provider(() => new Response("x".repeat(70_000))).p.current(loc)).toMatchObject({
      code: "INVALID_RESPONSE",
    });
    const net = await provider(() => {
      throw new Error("ECONNRESET with SECRET-KEY-VALUE");
    }).p.current(loc);
    expect(net).toMatchObject({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify(net)).not.toContain("SECRET");
  });

  it("times out", async () => {
    const { p } = provider(
      (_u, init) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
      { timeoutMs: 20 },
    );
    expect(await p.current(loc)).toMatchObject({ ok: false, code: "TIMEOUT" });
  });

  it("rejects an invalid facility location without calling the network", async () => {
    const { p, calls } = provider(() => json(goodBody()));
    expect(await p.current({ latitude: 91, longitude: 0 })).toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(await p.current({ latitude: Number.NaN, longitude: 0 })).toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(calls).toHaveLength(0);
  });
});

const policy: WeatherPolicy = {
  cacheTtlSeconds: 600,
  failureBackoffSeconds: 120,
  maxFetchesPerDay: 3,
  staleAfterSeconds: 3600,
};

function world(
  script: (WeatherResult | (() => Promise<WeatherResult>))[],
  over: Partial<WeatherPolicy> = {},
) {
  const clock = new ManualClock(T0);
  const store = new InMemoryTenantDocumentStore();
  const bus = new InMemoryBus();
  const registry = new InMemoryDeviceRegistry([
    createEdgeDeviceRecord({
      deviceId: "DEV-SIM-WX-01",
      keyId: "KEY-NONE-INTERNAL",
      organizationId: "ORG-1",
      facilityId: "FAC-1",
      assetId: "AST-SIM-OUTDOOR",
      expectedSignals: ["outdoor_temperature"],
      capabilities: ["pull"],
    }),
  ]);
  const live = new ScriptedWeatherProvider(script);
  let simulatedC: number | undefined = 46;
  const simulated = new SimulatedWeatherProvider(clock, () => simulatedC);
  const audit = new InMemoryAuditLog();
  const service = createWeatherService({
    clock,
    store,
    policy: { ...policy, ...over },
    live,
    simulated,
    bus,
    ids: new SequentialIdGenerator(),
    registry,
    audit,
    weatherDeviceId: "DEV-SIM-WX-01",
  });
  const ctx = {
    organizationId: "ORG-1",
    facilityId: "FAC-1",
    location: loc,
    mode: "LIVE" as const,
  };
  return {
    clock,
    live,
    service,
    bus,
    registry,
    audit,
    ctx,
    setSimulated: (v: number | undefined) => (simulatedC = v),
  };
}

const reading = (minutesAgo: number, tempC: number): WeatherReading => ({
  provider: "GOOGLE_WEATHER",
  live: true,
  observedAt: new Date(T0 - minutesAgo * 60_000).toISOString(),
  fetchedAt: new Date(T0).toISOString(),
  temperatureC: tempC,
});
const okAt = (minutesAgo: number, t = 41): WeatherResult => ({
  ok: true,
  reading: reading(minutesAgo, t),
});

describe("WeatherService caching, budget and honesty", () => {
  it("reuses a fresh cached reading and does not call the provider again", async () => {
    const w = world([okAt(2)]);
    const first = await w.service.view(w.ctx);
    expect(first).toMatchObject({ status: "LIVE", live: true, ageSeconds: 120 });
    w.clock.advance(300_000);
    const second = await w.service.view(w.ctx);
    expect(w.live.calls).toHaveLength(1);
    expect(second.status).toBe("LIVE");
    // The cached reading keeps the PROVIDER's timestamp; age grows, the timestamp never moves.
    expect(second.reading?.observedAt).toBe(first.reading?.observedAt);
    expect(second.ageSeconds).toBe(420);
  });

  it("calls again after the cache window", async () => {
    const w = world([okAt(2), okAt(1, 42)]);
    await w.service.view(w.ctx);
    w.clock.advance(601_000);
    const v = await w.service.view(w.ctx);
    expect(w.live.calls).toHaveLength(2);
    expect(v.reading?.temperatureC).toBe(42);
  });

  it("reports UNAVAILABLE, never a made-up value, when the provider fails and nothing is cached", async () => {
    const w = world([{ ok: false, code: "TIMEOUT", message: "weather provider timed out" }]);
    const v = await w.service.view(w.ctx);
    expect(v).toMatchObject({ status: "UNAVAILABLE", live: false });
    expect(v.reading).toBeUndefined();
    expect(v.failure?.code).toBe("TIMEOUT");
    expect(v.label).toBe("WEATHER UNAVAILABLE / INSUFFICIENT CONTEXT");
  });

  it("does not hammer a failing provider (back-off)", async () => {
    const w = world([{ ok: false, code: "HTTP_ERROR", message: "x" }]);
    await w.service.view(w.ctx);
    w.clock.advance(60_000);
    await w.service.view(w.ctx);
    expect(w.live.calls).toHaveLength(1);
    w.clock.advance(61_000);
    await w.service.view(w.ctx);
    expect(w.live.calls).toHaveLength(2);
  });

  it("marks an old reading STALE after a failure instead of re-stamping it", async () => {
    const w = world([okAt(2), { ok: false, code: "UNAVAILABLE", message: "down" }]);
    await w.service.view(w.ctx);
    w.clock.advance(601_000 + 3_600_000);
    const v = await w.service.view(w.ctx);
    expect(v.status).toBe("STALE");
    expect(v.live).toBe(true); // it was a real provider reading
    expect(v.reading?.observedAt).toBe(new Date(T0 - 120_000).toISOString());
    expect(v.label).toMatch(/^WEATHER STALE/);
  });

  it("enforces the daily call budget", async () => {
    const w = world([okAt(1), okAt(1), okAt(1), okAt(1)], {
      cacheTtlSeconds: 60,
      failureBackoffSeconds: 60,
      maxFetchesPerDay: 2,
    });
    for (let i = 0; i < 4; i += 1) {
      await w.service.view(w.ctx);
      w.clock.advance(120_000);
    }
    expect(w.live.calls).toHaveLength(2);
    const v = await w.service.view(w.ctx);
    expect(v.callsToday).toBe(2);
    expect(v.maxCallsPerDay).toBe(2);
    // A new UTC day resets the budget.
    w.clock.advance(24 * 3_600_000);
    await w.service.view(w.ctx);
    expect(w.live.calls).toHaveLength(3);
  });

  it("is NOT_CONFIGURED without a live provider and never falls back to simulated weather", async () => {
    const clock = new ManualClock(T0);
    const service = createWeatherService({
      clock,
      store: new InMemoryTenantDocumentStore(),
      policy,
      simulated: new SimulatedWeatherProvider(clock, () => 50),
      bus: new InMemoryBus(),
      ids: new SequentialIdGenerator(),
      registry: new InMemoryDeviceRegistry(),
      audit: new InMemoryAuditLog(),
      weatherDeviceId: "DEV-SIM-WX-01",
    });
    const v = await service.view({
      organizationId: "O",
      facilityId: "F",
      location: loc,
      mode: "LIVE",
    });
    expect(v).toMatchObject({ status: "NOT_CONFIGURED", live: false });
    expect(v.reading).toBeUndefined();
  });

  it("simulated weather is labelled and never live", async () => {
    const w = world([okAt(2)]);
    const v = await w.service.view({ ...w.ctx, mode: "SIMULATED" });
    expect(v).toMatchObject({ status: "SIMULATED", live: false, provider: "SIMULATED" });
    expect(v.label).toMatch(/^SIMULATED WEATHER/);
    expect(v.reading).toMatchObject({ live: false, temperatureC: 46 });
    expect(w.live.calls).toHaveLength(0);
    w.setSimulated(undefined);
    expect((await w.service.view({ ...w.ctx, mode: "SIMULATED" })).status).toBe("UNAVAILABLE");
  });

  it("audits status transitions", async () => {
    const w = world([okAt(2), { ok: false, code: "UNAVAILABLE", message: "down" }]);
    await w.service.view(w.ctx);
    await w.service.view(w.ctx);
    w.clock.advance(601_000 + 3_600_000);
    await w.service.view(w.ctx);
    const entries = (await w.audit.list("ORG-1")).filter(
      (e) => e.action === "WEATHER_STATUS_CHANGED",
    );
    expect(entries.map((e) => e.afterState)).toEqual(["LIVE", "STALE"]);
  });
});

describe("WeatherService ingestion into the canonical pipeline", () => {
  it("feeds one internal-pull observation per NEW provider reading, with the provider's timestamp", async () => {
    const w = world([okAt(3), okAt(3), okAt(1, 43)], {
      cacheTtlSeconds: 60,
      failureBackoffSeconds: 60,
    });
    await w.service.ingest(w.ctx);
    w.clock.advance(61_000); // cache expired: the provider is asked again and answers the SAME observation
    await w.service.ingest(w.ctx);
    const events = w.bus.history().filter((e) => e.event_type === "telemetry.authenticated.v1");
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.event_type !== "telemetry.authenticated.v1") throw new Error("type");
    expect(e.payload.origin).toBe("INTERNAL_PULL");
    expect(e.payload.telemetry.source).toBe("WEATHER_API");
    expect(e.payload.telemetry.batch[0]?.observed_at).toBe(new Date(T0 - 180_000).toISOString());
    expect(e.payload.telemetry.batch[0]?.readings).toEqual({ outdoor_temperature_c: 41 });
    expect(e.payload.deviceHealth).toBe("HEALTHY");
    // A later, genuinely new reading is fed in again.
    w.clock.advance(120_000);
    await w.service.ingest(w.ctx);
    expect(
      w.bus.history().filter((x) => x.event_type === "telemetry.authenticated.v1"),
    ).toHaveLength(2);
  });

  it("feeds nothing and marks the source DEGRADED when weather is unavailable", async () => {
    const w = world([{ ok: false, code: "TIMEOUT", message: "t" }]);
    await w.service.ingest(w.ctx);
    expect(
      w.bus.history().filter((e) => e.event_type === "telemetry.authenticated.v1"),
    ).toHaveLength(0);
    expect((await w.registry.get("DEV-SIM-WX-01"))?.health).toBe("DEGRADED");
  });

  it("simulated weather enters as SIMULATOR data, not weather-provider data", async () => {
    const w = world([okAt(2)]);
    await w.service.ingest({ ...w.ctx, mode: "SIMULATED" });
    const e = w.bus.history().find((x) => x.event_type === "telemetry.authenticated.v1");
    if (e?.event_type !== "telemetry.authenticated.v1") throw new Error("type");
    expect(e.payload.telemetry.source).toBe("SIMULATOR");
    expect(e.payload.telemetry.batch[0]?.readings).toEqual({ outdoor_temperature_c: 46 });
  });
});
