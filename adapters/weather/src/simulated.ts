import type {
  WeatherLocation,
  WeatherProvider,
  WeatherReading,
  WeatherResult,
} from "@symbiosis/contracts";
import type { Clock } from "@symbiosis/clock";
import { nowIso } from "@symbiosis/clock";

/**
 * Deterministic SIMULATED weather (S10, D-089): the evaluator's chosen outdoor temperature, reported
 * as a reading that is never live. It exists so a demo can show a heat wave on a mild day, and it is
 * labelled SIMULATED everywhere. It is never used silently as a fallback for a failed live provider.
 */
export class SimulatedWeatherProvider implements WeatherProvider {
  readonly name = "SIMULATED" as const;

  constructor(
    private readonly clock: Clock,
    /** The simulated outdoor temperature in degC right now, or undefined when none is set. */
    private readonly outdoorTemperatureC: () => number | undefined | Promise<number | undefined>,
  ) {}

  async current(): Promise<WeatherResult> {
    const t = await this.outdoorTemperatureC();
    if (t === undefined || !Number.isFinite(t)) {
      return { ok: false, code: "UNAVAILABLE", message: "no simulated outdoor temperature is set" };
    }
    const now = nowIso(this.clock);
    const reading: WeatherReading = {
      provider: "SIMULATED",
      live: false,
      observedAt: now,
      fetchedAt: now,
      temperatureC: t,
      condition: "Simulated",
    };
    return { ok: true, reading };
  }
}

/** Test double: answers from a script, in order, repeating the last answer. */
export class ScriptedWeatherProvider implements WeatherProvider {
  readonly name: "GOOGLE_WEATHER" | "SIMULATED";
  readonly calls: WeatherLocation[] = [];
  private index = 0;

  constructor(
    private readonly script: readonly (WeatherResult | (() => Promise<WeatherResult>))[],
    name: "GOOGLE_WEATHER" | "SIMULATED" = "GOOGLE_WEATHER",
  ) {
    this.name = name;
  }

  async current(location: WeatherLocation): Promise<WeatherResult> {
    this.calls.push(location);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (step === undefined) {
      return { ok: false, code: "UNAVAILABLE", message: "no scripted answer" };
    }
    return typeof step === "function" ? step() : step;
  }
}
