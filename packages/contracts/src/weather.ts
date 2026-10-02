import type { IsoTimestamp } from "./primitives";

/**
 * External weather context (S10, D-089). Weather is facts from a provider, never generated text and
 * never produced by an AI model. Only `temperatureC` feeds deterministic risk logic (the rule uses
 * outdoor temperature); the other fields are shown to people and never reach a rule.
 */
export const WEATHER_PROVIDERS = ["GOOGLE_WEATHER", "SIMULATED"] as const;
export type WeatherProviderName = (typeof WEATHER_PROVIDERS)[number];

export type WeatherLocation = {
  readonly latitude: number;
  readonly longitude: number;
};

export type WeatherReading = {
  readonly provider: WeatherProviderName;
  /** True only for data a real provider returned. Simulated weather is never live. */
  readonly live: boolean;
  /** The provider's own observation time. It is never rewritten, not even for a cached reading. */
  readonly observedAt: IsoTimestamp;
  /** When this system obtained the reading from the provider. */
  readonly fetchedAt: IsoTimestamp;
  readonly temperatureC: number;
  /** Display only. */
  readonly relativeHumidityPct?: number;
  readonly condition?: string;
  readonly windSpeedKph?: number;
};

export const WEATHER_FAILURE_CODES = [
  "TIMEOUT",
  "HTTP_ERROR",
  "INVALID_RESPONSE",
  "UNAVAILABLE",
  "QUOTA_EXHAUSTED",
  "NOT_CONFIGURED",
] as const;
export type WeatherFailureCode = (typeof WEATHER_FAILURE_CODES)[number];

export type WeatherResult =
  | { readonly ok: true; readonly reading: WeatherReading }
  | {
      readonly ok: false;
      readonly code: WeatherFailureCode;
      readonly message: string;
    };

/** Port. Implementations: Google Maps Platform Weather API, deterministic simulated, scripted fake. */
export interface WeatherProvider {
  readonly name: WeatherProviderName;
  current(location: WeatherLocation): Promise<WeatherResult>;
}
