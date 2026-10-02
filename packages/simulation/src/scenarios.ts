import { validateStatePatch } from "./state";
import type { StatePatch } from "./state";

/**
 * Scenario library (S10, D-091). A scenario is a description of the PHYSICAL world: values, a ramp
 * time, a weather mode. It has no field that could carry a business outcome. `expectation` is text
 * for the evaluator; no code reads it, and what the platform actually concludes is decided by the
 * deterministic pipeline from the readings the scenario produces.
 */
export const SCENARIO_IDS = [
  "NORMAL",
  "EMERGING_DETERIORATION",
  "COMPOUND_COOLING_RISK",
  "INEFFECTIVE_MITIGATION",
  "SUCCESSFUL_MITIGATION",
  "SENSOR_QUALITY_FAILURE",
  "RECURRENCE",
] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export type WeatherMode = "LIVE" | "SIMULATED";

export type ScenarioDefinition = {
  readonly id: ScenarioId;
  readonly label: string;
  readonly summary: string;
  readonly values: StatePatch;
  readonly rampSeconds: number;
  readonly weatherMode: WeatherMode;
  readonly world: string;
  readonly expectation: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseScenarios(value: unknown): readonly ScenarioDefinition[] {
  const fail = (why: string): never => {
    throw new Error(`invalid simulation scenarios: ${why}`);
  };
  if (
    !isRecord(value) ||
    value.schema !== "simulation-scenarios.v1" ||
    !Array.isArray(value.scenarios)
  ) {
    return fail("schema");
  }
  const out: ScenarioDefinition[] = [];
  for (const s of value.scenarios as unknown[]) {
    if (!isRecord(s)) return fail("scenario");
    if (!(SCENARIO_IDS as readonly unknown[]).includes(s.id)) fail(`unknown id ${String(s.id)}`);
    for (const k of Object.keys(s)) {
      if (
        ![
          "id",
          "label",
          "summary",
          "values",
          "rampSeconds",
          "weatherMode",
          "world",
          "expectation",
        ].includes(k)
      ) {
        fail(
          `scenario ${String(s.id)} has an unknown key "${k}" (scenarios describe the physical world only)`,
        );
      }
    }
    for (const k of ["label", "summary", "world", "expectation"] as const) {
      if (typeof s[k] !== "string" || (s[k] as string).trim() === "") fail(`${String(s.id)}.${k}`);
    }
    const patch = validateStatePatch(s.values);
    if (!patch.ok) return fail(`${String(s.id)}: ${patch.issues.join("; ")}`);
    const ramp = s.rampSeconds;
    if (typeof ramp !== "number" || !Number.isFinite(ramp) || ramp < 0 || ramp > 900)
      fail(`${String(s.id)}.rampSeconds`);
    if (s.weatherMode !== "LIVE" && s.weatherMode !== "SIMULATED")
      fail(`${String(s.id)}.weatherMode`);
    out.push({
      id: s.id as ScenarioId,
      label: s.label as string,
      summary: s.summary as string,
      values: patch.patch,
      rampSeconds: ramp as number,
      weatherMode: s.weatherMode as WeatherMode,
      world: s.world as string,
      expectation: s.expectation as string,
    });
  }
  for (const id of SCENARIO_IDS) {
    if (!out.some((s) => s.id === id)) fail(`missing scenario ${id}`);
  }
  if (new Set(out.map((s) => s.id)).size !== out.length) fail("duplicate scenario");
  return out;
}
