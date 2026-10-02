import type {
  WeatherFailureCode,
  WeatherLocation,
  WeatherProvider,
  WeatherProviderName,
  WeatherReading,
} from "@symbiosis/contracts";
import type { AuditLog } from "@symbiosis/audit";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { DeviceRegistry } from "@symbiosis/device-registry";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";
import type { TenantDocumentStore } from "@symbiosis/repositories";

/**
 * External weather context for one facility (S10, D-089).
 *
 * - Providers sit behind the `WeatherProvider` port; this service owns caching, a daily call budget
 *   and ingestion. It never fabricates a value: a failed or missing provider answer is UNAVAILABLE,
 *   and an older cached reading keeps its own provider timestamp (it is never re-stamped as newer).
 * - Only the outdoor temperature enters risk logic, through the same normalization, data-quality
 *   and detection path as every other observation, as an INTERNAL_PULL observation.
 * - SIMULATED weather is a separate, explicit mode. A live failure never falls back to it.
 */
export type WeatherPolicy = {
  /** A cached live reading younger than this is reused; the provider is not called. */
  readonly cacheTtlSeconds: number;
  /** After a failed call, no further call is made for this long. */
  readonly failureBackoffSeconds: number;
  /** Hard cap on provider calls per UTC day, per facility (cost protection). */
  readonly maxFetchesPerDay: number;
  /** A reading whose provider time is older than this is reported STALE. */
  readonly staleAfterSeconds: number;
};

export const WEATHER_STATUSES = [
  "LIVE",
  "SIMULATED",
  "STALE",
  "UNAVAILABLE",
  "NOT_CONFIGURED",
] as const;
export type WeatherStatus = (typeof WEATHER_STATUSES)[number];

export type WeatherView = {
  readonly status: WeatherStatus;
  readonly mode: "LIVE" | "SIMULATED";
  readonly provider: WeatherProviderName | null;
  /** True only for a reading a real provider returned. */
  readonly live: boolean;
  readonly reading?: WeatherReading;
  readonly ageSeconds?: number;
  readonly failure?: { readonly code: WeatherFailureCode; readonly message: string };
  readonly nextRefreshAt?: string;
  readonly callsToday: number;
  readonly maxCallsPerDay: number;
  /** Deterministic wording shown next to the data. */
  readonly label: string;
};

type CacheDoc = {
  readonly key: string;
  readonly reading?: WeatherReading;
  readonly lastAttemptMs: number;
  readonly lastFailure?: { code: WeatherFailureCode; message: string; atMs: number };
  readonly dayKey: string;
  readonly dayCount: number;
  readonly lastIngestedObservedAt?: string;
  readonly lastStatus?: WeatherStatus;
};

export type WeatherContext = {
  readonly organizationId: string;
  readonly facilityId: string;
  readonly location: WeatherLocation;
  readonly mode: "LIVE" | "SIMULATED";
};

export type WeatherServiceDeps = {
  readonly clock: Clock;
  readonly store: TenantDocumentStore;
  readonly policy: WeatherPolicy;
  /** Absent: LIVE mode reports NOT_CONFIGURED. */
  readonly live?: WeatherProvider;
  readonly simulated: WeatherProvider;
  readonly bus: EventBus;
  readonly ids: IdGenerator;
  readonly registry: DeviceRegistry;
  readonly audit: AuditLog;
  /** The registered source device that stands for the weather feed of this facility. */
  readonly weatherDeviceId: string;
};

export interface WeatherService {
  /** Current weather for display; calls the provider only when the cache and budget allow. */
  view(ctx: WeatherContext): Promise<WeatherView>;
  /** `view`, then feeds a NEW provider observation into the canonical pipeline (once per reading). */
  ingest(ctx: WeatherContext): Promise<WeatherView>;
}

const dayKeyOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function createWeatherService(deps: WeatherServiceDeps): WeatherService {
  const { policy, store } = deps;
  const docId = (ctx: WeatherContext) => `${ctx.facilityId}-${ctx.mode}`;

  async function loadDoc(ctx: WeatherContext): Promise<CacheDoc> {
    return (
      (await store.get<CacheDoc>("weatherCache", ctx.organizationId, docId(ctx))) ?? {
        key: docId(ctx),
        lastAttemptMs: 0,
        dayKey: dayKeyOf(deps.clock.nowMs()),
        dayCount: 0,
      }
    );
  }

  const label = (status: WeatherStatus, reading?: WeatherReading): string => {
    switch (status) {
      case "LIVE":
        return "LIVE WEATHER · Google Maps Platform Weather API";
      case "SIMULATED":
        return "SIMULATED WEATHER · set by the evaluator, not a live reading";
      case "STALE":
        return `WEATHER STALE · last provider reading ${reading?.observedAt ?? "unknown"}`;
      case "NOT_CONFIGURED":
        return "WEATHER UNAVAILABLE · live weather is not configured";
      default:
        return "WEATHER UNAVAILABLE / INSUFFICIENT CONTEXT";
    }
  };

  async function recordStatus(ctx: WeatherContext, doc: CacheDoc, status: WeatherStatus) {
    if (doc.lastStatus === status) return doc;
    const next = { ...doc, lastStatus: status };
    await store.put("weatherCache", ctx.organizationId, docId(ctx), next);
    // Material transitions are audited (first observation of a status, then each change).
    await deps.audit.append({
      organizationId: ctx.organizationId,
      facilityId: ctx.facilityId,
      actorId: "SYSTEM-WEATHER",
      actorType: "SYSTEM",
      action: "WEATHER_STATUS_CHANGED",
      targetType: "WEATHER",
      targetId: docId(ctx),
      ...(doc.lastStatus !== undefined && { beforeState: doc.lastStatus }),
      afterState: status,
      correlationId: deps.ids.next("CORR"),
      at: nowIso(deps.clock),
      details: { mode: ctx.mode },
    });
    return next;
  }

  async function viewFor(ctx: WeatherContext): Promise<{ view: WeatherView; doc: CacheDoc }> {
    const nowMs = deps.clock.nowMs();
    let doc = await loadDoc(ctx);

    const finish = async (
      status: WeatherStatus,
      extra: Partial<WeatherView> = {},
    ): Promise<{ view: WeatherView; doc: CacheDoc }> => {
      doc = await recordStatus(ctx, doc, status);
      const reading = extra.reading ?? doc.reading;
      const today = doc.dayKey === dayKeyOf(nowMs) ? doc.dayCount : 0;
      return {
        doc,
        view: {
          status,
          mode: ctx.mode,
          provider: reading?.provider ?? (ctx.mode === "SIMULATED" ? "SIMULATED" : null),
          live: status === "LIVE" || (status === "STALE" && reading?.live === true),
          ...(reading !== undefined && {
            reading,
            ageSeconds: Math.max(0, Math.round((nowMs - Date.parse(reading.observedAt)) / 1000)),
          }),
          callsToday: today,
          maxCallsPerDay: policy.maxFetchesPerDay,
          label: label(status, reading),
          ...extra,
        },
      };
    };

    if (ctx.mode === "SIMULATED") {
      const result = await deps.simulated.current(ctx.location);
      if (!result.ok) {
        return finish("UNAVAILABLE", { failure: { code: result.code, message: result.message } });
      }
      return finish("SIMULATED", { reading: result.reading });
    }

    if (deps.live === undefined) {
      return finish("NOT_CONFIGURED", {
        failure: { code: "NOT_CONFIGURED", message: "live weather provider is not configured" },
      });
    }

    const live = deps.live;
    const today = dayKeyOf(nowMs);
    const cached = doc.reading;
    const fresh =
      cached !== undefined && nowMs - Date.parse(cached.fetchedAt) < policy.cacheTtlSeconds * 1000;
    const backingOff =
      doc.lastFailure !== undefined &&
      nowMs - doc.lastFailure.atMs < policy.failureBackoffSeconds * 1000;
    const used = doc.dayKey === today ? doc.dayCount : 0;

    const classify = (reading: WeatherReading | undefined): WeatherStatus => {
      if (reading === undefined) return "UNAVAILABLE";
      return nowMs - Date.parse(reading.observedAt) > policy.staleAfterSeconds * 1000
        ? "STALE"
        : "LIVE";
    };

    if (fresh || backingOff || used >= policy.maxFetchesPerDay) {
      const failure =
        used >= policy.maxFetchesPerDay && !fresh
          ? { code: "QUOTA_EXHAUSTED" as const, message: "daily weather call budget is used up" }
          : doc.lastFailure !== undefined && !fresh
            ? { code: doc.lastFailure.code, message: doc.lastFailure.message }
            : undefined;
      const status = classify(cached);
      return finish(status, {
        ...(failure !== undefined && { failure }),
        ...(cached !== undefined && {
          nextRefreshAt: new Date(
            Date.parse(cached.fetchedAt) + policy.cacheTtlSeconds * 1000,
          ).toISOString(),
        }),
      });
    }

    // Claim the attempt atomically so concurrent instances make at most one provider call per TTL.
    let claimed = false;
    const claimedDoc = await store.update<CacheDoc>(
      "weatherCache",
      ctx.organizationId,
      docId(ctx),
      (cur) => {
        const c: CacheDoc = cur ?? doc;
        const sameDay = c.dayKey === today;
        const attemptAgo = nowMs - c.lastAttemptMs;
        const tooSoon =
          attemptAgo < Math.min(policy.cacheTtlSeconds, policy.failureBackoffSeconds) * 1000;
        claimed = !tooSoon && (sameDay ? c.dayCount : 0) < policy.maxFetchesPerDay;
        if (!claimed) return undefined;
        return {
          doc: {
            ...c,
            lastAttemptMs: nowMs,
            dayKey: today,
            dayCount: (sameDay ? c.dayCount : 0) + 1,
          },
        };
      },
    );
    if (claimedDoc !== undefined) doc = claimedDoc;
    if (!claimed) return finish(classify(doc.reading));

    const result = await live.current(ctx.location);
    if (result.ok) {
      doc = {
        ...doc,
        reading: result.reading,
      };
      delete (doc as { lastFailure?: unknown }).lastFailure;
      await store.put("weatherCache", ctx.organizationId, docId(ctx), doc);
      return finish(classify(result.reading), { reading: result.reading });
    }
    doc = {
      ...doc,
      lastFailure: { code: result.code, message: result.message, atMs: nowMs },
    };
    await store.put("weatherCache", ctx.organizationId, docId(ctx), doc);
    // The old reading, if any, keeps its own timestamp; it is shown as STALE only when it is old.
    return finish(classify(doc.reading), {
      failure: { code: result.code, message: result.message },
    });
  }

  return {
    async view(ctx) {
      return (await viewFor(ctx)).view;
    },

    async ingest(ctx) {
      const { view, doc } = await viewFor(ctx);
      const reading = view.reading;
      const healthy = view.status === "LIVE" || view.status === "SIMULATED";
      const now = nowIso(deps.clock);
      await deps.registry.recordSeen(deps.weatherDeviceId, {
        seenAt: now,
        health: healthy ? "HEALTHY" : "DEGRADED",
      });
      // Only a NEW provider observation is fed in, and only while the reading is usable. The
      // provider's observation time is carried unchanged; the pipeline judges its freshness.
      if (reading === undefined || !healthy || doc.lastIngestedObservedAt === reading.observedAt) {
        return view;
      }
      const device = await deps.registry.get(deps.weatherDeviceId);
      if (device === undefined) return view;
      const correlationId = deps.ids.next("CORR");
      await deps.bus.publish(
        createEnvelope(deps.ids, {
          type: "telemetry.authenticated.v1",
          correlationId,
          causationId: null,
          organizationId: ctx.organizationId,
          facilityId: ctx.facilityId,
          occurredAt: now,
          producer: "api",
          payload: {
            deviceId: device.deviceId,
            keyId: "INTERNAL",
            seq: 0,
            receivedAt: now,
            assetId: device.assetId,
            expectedSignals: device.expectedSignals,
            deviceHealth: device.health,
            origin: "INTERNAL_PULL" as const,
            telemetry: {
              device_id: device.deviceId,
              firmware_version: "weather-pull-1",
              source: reading.live ? ("WEATHER_API" as const) : ("SIMULATOR" as const),
              batch: [
                {
                  observed_at: reading.observedAt,
                  readings: { outdoor_temperature_c: reading.temperatureC },
                },
              ],
            },
          },
        }),
      );
      await store.update<CacheDoc>("weatherCache", ctx.organizationId, docId(ctx), (cur) =>
        cur === undefined
          ? undefined
          : { doc: { ...cur, lastIngestedObservedAt: reading.observedAt } },
      );
      return view;
    },
  };
}
