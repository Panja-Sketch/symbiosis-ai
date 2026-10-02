import type { WeatherLocation, WeatherProvider, WeatherResult } from "@symbiosis/contracts";
import type { Clock } from "@symbiosis/clock";
import { nowIso } from "@symbiosis/clock";

/**
 * Google Maps Platform Weather API, current conditions (S10, D-089).
 *
 * Authentication is injected as headers so this file never sees how it is obtained: workload
 * identity (OAuth, preferred) or a restricted API key sent in the `X-Goog-Api-Key` header, never in
 * the URL. Nothing here logs a header, a URL with credentials or a response body. The provider's own
 * observation time (`currentTime`) is kept verbatim: a response without one is INVALID, not
 * "now". No weather value is ever invented.
 */
export type GoogleWeatherOptions = {
  readonly clock: Clock;
  readonly fetchImpl?: typeof fetch;
  /** Called for every request; must resolve to authentication headers (and a quota project if needed). */
  readonly authHeaders: () => Promise<Readonly<Record<string, string>>>;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** Responses larger than this are rejected before parsing. */
  readonly maxBytes?: number;
};

const DEFAULT_BASE = "https://weather.googleapis.com/v1/currentConditions:lookup";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

function toCelsius(value: number, unit: unknown): number | undefined {
  if (unit === "CELSIUS") return value;
  if (unit === "FAHRENHEIT") return ((value - 32) * 5) / 9;
  return undefined;
}

function toKph(value: number, unit: unknown): number | undefined {
  if (unit === "KILOMETERS_PER_HOUR") return value;
  if (unit === "MILES_PER_HOUR") return value * 1.609344;
  return undefined;
}

export class GoogleWeatherProvider implements WeatherProvider {
  readonly name = "GOOGLE_WEATHER" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GoogleWeatherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async current(location: WeatherLocation): Promise<WeatherResult> {
    if (
      !Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude) ||
      Math.abs(location.latitude) > 90 ||
      Math.abs(location.longitude) > 180
    ) {
      return { ok: false, code: "NOT_CONFIGURED", message: "facility location is invalid" };
    }
    const url =
      `${this.options.baseUrl ?? DEFAULT_BASE}` +
      `?location.latitude=${location.latitude}&location.longitude=${location.longitude}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 4000);
    try {
      const headers = await this.options.authHeaders();
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: controller.signal,
      });
      if (!response.ok) {
        // The status is enough; the body may echo request details and is not read.
        return {
          ok: false,
          code: "HTTP_ERROR",
          message: `weather provider answered ${response.status}`,
        };
      }
      const text = await response.text();
      if (text.length > (this.options.maxBytes ?? 65_536)) {
        return { ok: false, code: "INVALID_RESPONSE", message: "weather response is too large" };
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return { ok: false, code: "INVALID_RESPONSE", message: "weather response is not JSON" };
      }
      return this.parse(body);
    } catch (error) {
      if ((error as { name?: string } | null)?.name === "AbortError") {
        return { ok: false, code: "TIMEOUT", message: "weather provider timed out" };
      }
      return { ok: false, code: "UNAVAILABLE", message: "weather provider is unreachable" };
    } finally {
      clearTimeout(timer);
    }
  }

  private parse(body: unknown): WeatherResult {
    const invalid = (why: string): WeatherResult => ({
      ok: false,
      code: "INVALID_RESPONSE",
      message: `weather response invalid: ${why}`,
    });
    if (!isRecord(body)) return invalid("not an object");
    const currentTime = body.currentTime;
    if (typeof currentTime !== "string" || Number.isNaN(Date.parse(currentTime))) {
      return invalid("no observation time");
    }
    const observedMs = Date.parse(currentTime);
    const fetchedMs = this.options.clock.nowMs();
    // A provider time far in the future is not an observation.
    if (observedMs > fetchedMs + 5 * 60_000) return invalid("observation time is in the future");
    const t = body.temperature;
    if (!isRecord(t)) return invalid("no temperature");
    const degrees = num(t.degrees);
    const celsius = degrees === undefined ? undefined : toCelsius(degrees, t.unit);
    if (celsius === undefined || celsius < -90 || celsius > 65) return invalid("temperature");

    const humidity = num(body.relativeHumidity);
    const description =
      isRecord(body.weatherCondition) && isRecord(body.weatherCondition.description)
        ? body.weatherCondition.description.text
        : undefined;
    let wind: number | undefined;
    if (isRecord(body.wind) && isRecord(body.wind.speed)) {
      const v = num(body.wind.speed.value);
      wind = v === undefined ? undefined : toKph(v, body.wind.speed.unit);
    }
    return {
      ok: true,
      reading: {
        provider: "GOOGLE_WEATHER",
        live: true,
        observedAt: new Date(observedMs).toISOString(),
        fetchedAt: nowIso(this.options.clock),
        temperatureC: Math.round(celsius * 100) / 100,
        ...(humidity !== undefined &&
          humidity >= 0 &&
          humidity <= 100 && { relativeHumidityPct: humidity }),
        ...(typeof description === "string" &&
          description.length > 0 &&
          description.length <= 80 && {
            condition: description,
          }),
        ...(wind !== undefined &&
          wind >= 0 &&
          wind < 500 && { windSpeedKph: Math.round(wind * 10) / 10 }),
      },
    };
  }
}
