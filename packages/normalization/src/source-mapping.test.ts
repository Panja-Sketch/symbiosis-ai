import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SourceMappingDefinition } from "@symbiosis/contracts";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import { createAdapterCatalog } from "./catalog";
import {
  applySourceMapping,
  conversionFor,
  describeMapping,
  parsePath,
  parseSourceMapping,
  resolvePath,
} from "./source-mapping";

const dir = join(import.meta.dirname, "..", "..", "..", "config", "adapters");
const profiles = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as SourceMappingDefinition);
const profile = (id: string) => {
  const p = profiles.find((x) => x.profileId === id);
  if (p === undefined) throw new Error(`no profile ${id}`);
  return p;
};

const ctx = {
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  deviceId: "DEV-X-001",
  expectedSignals: [
    "temperature",
    "relative_humidity",
    "vibration_rms",
    "current",
    "load_percent",
    "equipment_running",
  ] as const,
  allowedAssetIds: ["AST-SIM-FAN-A", "AST-SIM-FAN-B", "AST-SIM-ZONE-1"],
  receivedAt: "2026-10-02T10:00:05.000Z",
};
const c = { ...ctx, expectedSignals: [...ctx.expectedSignals] };

describe("built-in profiles", () => {
  it("ship four valid, synthetic, SIMULATOR profiles", () => {
    expect(profiles.map((p) => p.profileId).sort()).toEqual([
      "sim-bas-gateway",
      "sim-electrical-meter",
      "sim-hvac-controller",
      "sim-vibration-gateway",
    ]);
    for (const p of profiles) {
      expect(parseSourceMapping(p).ok, p.profileId).toBe(true);
      expect(p.synthetic).toBe(true);
      expect(p.sourceType).toBe("SIMULATOR");
    }
  });
});

describe("vendor neutrality: different shapes, one canonical form", () => {
  const flat = {
    ts: "2026-10-02T10:00:00.000Z",
    equipment: "CH-01",
    vib_rms: 0.3,
    amps: 12,
    load_pct: 80,
    run_state: "RUN",
  };
  const vib = {
    sensor: "VG-7",
    channel: "motor-DE",
    sampledAtMs: Date.parse("2026-10-02T10:00:00.000Z"),
    rms: { value: 0.3 / 9.80665, unit: "g" },
  };
  const meter = {
    meterId: "EM-2",
    t: Date.parse("2026-10-02T10:00:00.000Z") / 1000,
    totals: { current: { v: 12000, u: "mA" }, load: { v: 0.8, u: "fraction" } },
    contactor: "CLOSED",
  };

  const canonical = (o: {
    signal: string;
    value: unknown;
    unit: string;
    assetId: string;
    observedAt: string;
  }) =>
    `${o.assetId}|${o.signal}|${typeof o.value === "number" ? Math.round((o.value as number) * 1e6) / 1e6 : String(o.value)}|${o.unit}|${o.observedAt}`;

  it("a flat BAS payload and a vibration gateway plus an electrical meter agree after conversion", () => {
    const a = applySourceMapping(profile("sim-bas-gateway"), flat, c)
      .observations.map(canonical)
      .sort();
    const parts = [
      ...applySourceMapping(profile("sim-vibration-gateway"), vib, c).observations,
      ...applySourceMapping(profile("sim-electrical-meter"), meter, c).observations,
    ]
      .map(canonical)
      .sort();
    expect(parts).toEqual(a);
    expect(a).toContain("AST-SIM-FAN-A|current|12|A|2026-10-02T10:00:00.000Z");
    expect(a).toContain("AST-SIM-FAN-A|vibration_rms|0.3|m/s2|2026-10-02T10:00:00.000Z");
  });

  it("converts units exactly and records the conversion", () => {
    const out = applySourceMapping(profile("sim-electrical-meter"), meter, c);
    const cur = out.fields.find((f) => f.signal === "current");
    expect(cur).toMatchObject({
      status: "ACCEPTED",
      sourceValue: 12000,
      sourceUnit: "mA",
      canonicalUnit: "A",
      canonicalValue: 12,
      conversion: "value x 0.001",
    });
    const load = out.fields.find((f) => f.signal === "load_percent");
    expect(load).toMatchObject({ canonicalValue: 80, conversion: "value x 100" });
  });

  it("converts Fahrenheit and fraction humidity from the nested controller shape", () => {
    const hvac = {
      sampled: "2026-10-02T10:00:00.000Z",
      zone: { temp: { value: 39.56, unit: "degF" }, rh: { value: 0.551, unit: "fraction" } },
      backup: { status: "STOP" },
    };
    const out = applySourceMapping(profile("sim-hvac-controller"), hvac, c);
    const t = out.observations.find((o) => o.signal === "temperature");
    expect(t?.value).toBeCloseTo(4.2, 2);
    expect(out.observations.find((o) => o.signal === "relative_humidity")?.value).toBeCloseTo(
      55.1,
      6,
    );
    const backup = out.observations.find((o) => o.signal === "equipment_running");
    expect(backup).toMatchObject({ value: false, assetId: "AST-SIM-FAN-B" });
  });

  it("stamps provenance: SIMULATOR source type and a versioned adapter name", () => {
    const out = applySourceMapping(profile("sim-bas-gateway"), flat, c);
    for (const o of out.observations) {
      expect(o.sourceType).toBe("SIMULATOR");
      expect(o.sourceAdapter).toBe("sim-bas-gateway@v1");
    }
  });
});

describe("fail-closed rejections", () => {
  const run = (payload: unknown, id = "sim-bas-gateway", over: Partial<typeof c> = {}) =>
    applySourceMapping(profile(id), payload, { ...c, ...over });
  const base = {
    ts: "2026-10-02T10:00:00.000Z",
    equipment: "CH-01",
    vib_rms: 0.3,
    amps: 12,
    load_pct: 80,
    run_state: "RUN",
  };

  it("rejects a missing field and keeps the rest", () => {
    const rest: Partial<typeof base> = { ...base };
    delete rest.amps;
    const out = run(rest);
    expect(out.fields.find((f) => f.signal === "current")?.reason).toBe("MISSING_FIELD");
    expect(out.observations.map((o) => o.signal)).not.toContain("current");
    expect(out.observations.length).toBe(3);
  });

  it("rejects wrong types, non-finite numbers and out-of-bounds values", () => {
    expect(run({ ...base, amps: "12" }).fields.find((f) => f.signal === "current")?.reason).toBe(
      "VALUE_TYPE_MISMATCH",
    );
    expect(
      run({ ...base, vib_rms: 1e9 }).fields.find((f) => f.signal === "vibration_rms")?.reason,
    ).toBe("OUT_OF_BOUNDS");
    expect(run({ ...base, amps: -1 }).fields.find((f) => f.signal === "current")?.reason).toBe(
      "OUT_OF_BOUNDS",
    );
  });

  it("rejects an unlisted enum value", () => {
    expect(
      run({ ...base, run_state: "MAYBE" }).fields.find((f) => f.signal === "equipment_running")
        ?.reason,
    ).toBe("UNKNOWN_ENUM_VALUE");
  });

  it("rejects an unmapped source asset and an asset the device is not registered for", () => {
    expect(run({ ...base, equipment: "CH-99" }).observations).toHaveLength(0);
    expect(run({ ...base, equipment: "CH-99" }).fields[0]?.reason).toBe("UNMAPPED_ASSET");
    const out = run(base, "sim-bas-gateway", { allowedAssetIds: ["AST-SIM-FAN-B"] });
    expect(out.observations).toHaveLength(0);
    expect(out.fields.every((f) => f.reason === "ASSET_NOT_PERMITTED")).toBe(true);
  });

  it("rejects readings for signals the device does not declare", () => {
    const out = run(base, "sim-bas-gateway", { expectedSignals: ["current"] });
    expect(out.observations.map((o) => o.signal)).toEqual(["current"]);
    expect(out.fields.filter((f) => f.reason === "SIGNAL_NOT_EXPECTED")).toHaveLength(3);
  });

  it("rejects everything when the timestamp is invalid", () => {
    for (const ts of ["yesterday", "", 12, null, "2026-10-02 10:00:00"]) {
      const out = run({ ...base, ts });
      expect(out.observations).toHaveLength(0);
      expect(out.fields.every((f) => f.reason === "INVALID_TIMESTAMP")).toBe(true);
    }
  });

  it("rejects an incompatible unit at payload time (a velocity is not an acceleration)", () => {
    const vib = {
      channel: "motor-DE",
      sampledAtMs: Date.parse("2026-10-02T10:00:00.000Z"),
      rms: { value: 4.7, unit: "mm/s" },
    };
    const out = run(vib, "sim-vibration-gateway");
    expect(out.observations).toHaveLength(0);
    expect(out.fields[0]).toMatchObject({ status: "REJECTED", reason: "INCOMPATIBLE_UNIT" });
    expect(out.fields[0]?.detail).toMatch(/velocity/);
  });

  it("never reads inherited or prototype properties", () => {
    expect(resolvePath({ a: 1 }, "constructor")).toBeUndefined();
    expect(resolvePath(JSON.parse('{"x":{"__proto__":{"y":1}}}'), "x.y")).toBeUndefined();
    expect(parsePath("__proto__")).toBeUndefined();
    expect(parsePath("a.constructor.b")).toBeUndefined();
    expect(parsePath("a..b")).toBeUndefined();
    expect(parsePath("a[1000]")).toBeUndefined();
    expect(parsePath("$.a")).toBeUndefined();
    expect(parsePath("a[*]")).toBeUndefined();
    expect(parsePath("a.b[2].c")).toEqual(["a", "b", 2, "c"]);
  });
});

describe("definition validation (closed schema, no executable content)", () => {
  const good = () =>
    structuredClone(profile("sim-bas-gateway")) as unknown as Record<string, unknown>;
  const issuesOf = (d: unknown) => {
    const r = parseSourceMapping(d);
    return r.ok ? [] : r.issues;
  };

  it("accepts the shipped definition", () => {
    expect(issuesOf(good())).toEqual([]);
  });

  it("rejects expression, script and eval-like keys anywhere", () => {
    const d = good();
    d.expression = "value * 2";
    expect(issuesOf(d).join(" ")).toMatch(/unknown key "expression"/);
    const e = good();
    (e.fields as Record<string, unknown>[])[0] = {
      ...(e.fields as Record<string, unknown>[])[0],
      convert: "x => x*2",
    };
    expect(issuesOf(e).join(" ")).toMatch(/fields\[0\]\.convert is not allowed/);
    const f = good();
    (f.fields as Record<string, unknown>[])[0] = {
      ...(f.fields as Record<string, unknown>[])[0],
      eval: "1",
    };
    expect(issuesOf(f).length).toBeGreaterThan(0);
  });

  it("rejects bad schema, ids, source types and synthetic inconsistencies", () => {
    expect(issuesOf({ ...good(), schema: "x" })).not.toEqual([]);
    expect(issuesOf({ ...good(), profileId: "Bad Id" })).not.toEqual([]);
    expect(issuesOf({ ...good(), sourceType: "WEATHER_API" })).not.toEqual([]);
    expect(issuesOf({ ...good(), synthetic: false })).not.toEqual([]); // SIMULATOR must be synthetic
    expect(issuesOf({ ...good(), version: 0 })).not.toEqual([]);
    expect(issuesOf({ ...good(), version: 1.5 })).not.toEqual([]);
  });

  it("rejects unknown signals, duplicate signals, wrong value types and missing units", () => {
    const f = (fields: unknown) => issuesOf({ ...good(), fields });
    expect(
      f([{ signal: "nope", path: "a", valueType: "number", unit: { fixed: "A" } }]),
    ).not.toEqual([]);
    expect(
      f([
        { signal: "current", path: "a", valueType: "number", unit: { fixed: "A" } },
        { signal: "current", path: "b", valueType: "number", unit: { fixed: "A" } },
      ]).join(" "),
    ).toMatch(/mapped twice/);
    expect(f([{ signal: "current", path: "a", valueType: "boolean" }]).join(" ")).toMatch(
      /valueType/,
    );
    expect(f([{ signal: "current", path: "a", valueType: "number" }]).join(" ")).toMatch(
      /unit is required/,
    );
    expect(f([])).not.toEqual([]);
  });

  it("fails closed on an incompatible or unknown unit at definition time", () => {
    const f = (unit: unknown) =>
      issuesOf({
        ...good(),
        fields: [{ signal: "vibration_rms", path: "a", valueType: "number", unit }],
      });
    expect(f({ fixed: "mm/s" }).join(" ")).toMatch(/velocity/);
    expect(f({ fixed: "furlongs" }).join(" ")).toMatch(/cannot be converted/);
    expect(f({ path: "u", allowed: ["g", "mm/s"] }).join(" ")).toMatch(/velocity/);
    expect(f({ path: "u", allowed: [] })).not.toEqual([]);
  });

  it("rejects invalid paths, asset maps and bounds", () => {
    expect(issuesOf({ ...good(), timestamp: { path: "a..b", format: "ISO_8601" } })).not.toEqual(
      [],
    );
    expect(issuesOf({ ...good(), asset: { path: "equipment" } }).join(" ")).toMatch(
      /map is required/,
    );
    expect(issuesOf({ ...good(), asset: { fixed: "bad id!" } })).not.toEqual([]);
    expect(
      issuesOf({ ...good(), asset: { fixed: "AST-1", path: "x", map: { a: "AST-1" } } }),
    ).not.toEqual([]);
    const f = good();
    (f.fields as Record<string, unknown>[])[0] = {
      ...(f.fields as Record<string, unknown>[])[0],
      bounds: { min: 5, max: 1 },
    };
    expect(issuesOf(f).join(" ")).toMatch(/min < max/);
  });

  it("rejects non-object input", () => {
    for (const bad of [null, [], "x", 3, undefined]) expect(issuesOf(bad)).not.toEqual([]);
  });
});

describe("unit table", () => {
  it("is exact for the supported units", () => {
    const f = (s: Parameters<typeof conversionFor>[0], u: string, v: number) => {
      const r = conversionFor(s, u);
      return r.ok ? r.conversion.apply(v) : NaN;
    };
    expect(f("temperature", "degF", 212)).toBeCloseTo(100, 10);
    expect(f("temperature", "K", 273.15)).toBeCloseTo(0, 10);
    expect(f("outdoor_temperature", "degF", 105)).toBeCloseTo(40.5556, 3);
    expect(f("vibration_rms", "g", 1)).toBeCloseTo(9.80665, 6);
    expect(f("current", "kA", 0.01)).toBeCloseTo(10, 10);
    expect(conversionFor("current", "g").ok).toBe(false);
    expect(conversionFor("equipment_running", "A").ok).toBe(false);
  });
});

describe("describeMapping", () => {
  it("lists every accepted unit with its conversion for display", () => {
    const d = describeMapping(profile("sim-electrical-meter"));
    const cur = d.find((x) => x.signal === "current");
    expect(cur?.units).toEqual([
      { unit: "A", conversion: "identity (same unit)" },
      { unit: "mA", conversion: "value x 0.001" },
    ]);
  });
});

describe("adapter catalog (versioned, immutable history)", () => {
  const make = () =>
    createAdapterCatalog({ builtins: profiles, store: new InMemoryTenantDocumentStore() });
  const meta = { actorId: "USR-1", reason: "Add a bound", at: "2026-10-02T10:00:00.000Z" };

  it("serves version 1 as the built-in active version", async () => {
    const cat = make();
    expect((await cat.getActive("ORG-1", "sim-bas-gateway"))?.version).toBe(1);
    const list = await cat.listProfiles("ORG-1");
    expect(list).toHaveLength(4);
    expect(list[0]?.versions[0]).toMatchObject({ version: 1, builtin: true });
  });

  it("publishes a new version with actor, time and reason, and keeps the old one", async () => {
    const cat = make();
    const next = structuredClone(profile("sim-bas-gateway"));
    const fields = [...next.fields];
    fields[0] = { ...fields[0], bounds: { min: 0, max: 20 } } as (typeof fields)[number];
    const r = await cat.publish("ORG-1", { ...next, fields, version: 99 }, meta);
    expect(r).toEqual({ ok: true, version: 2 }); // the request's version is ignored
    expect((await cat.getActive("ORG-1", "sim-bas-gateway"))?.version).toBe(2);
    expect(
      (await cat.getVersion("ORG-1", "sim-bas-gateway", 1))?.definition.fields[0]?.bounds?.max,
    ).toBe(100);
    const rec = await cat.getVersion("ORG-1", "sim-bas-gateway", 2);
    expect(rec).toMatchObject({ builtin: false, publishedBy: "USR-1", reason: "Add a bound" });
    expect((await cat.listProfiles("ORG-1"))[0]?.versions).toHaveLength(2);
  });

  it("refuses invalid, unknown and identity-changing candidates and writes nothing", async () => {
    const cat = make();
    const bad = { ...structuredClone(profile("sim-bas-gateway")), fields: [] };
    const r1 = await cat.publish("ORG-1", bad, meta);
    expect(r1).toMatchObject({ ok: false, code: "INVALID" });
    expect(await cat.publish("ORG-1", { profileId: "other-vendor" }, meta)).toMatchObject({
      ok: false,
      code: "UNKNOWN_PROFILE",
    });
    expect(
      await cat.publish(
        "ORG-1",
        { ...structuredClone(profile("sim-bas-gateway")), sourceType: "BMS", synthetic: false },
        meta,
      ),
    ).toMatchObject({ ok: false, code: "IMMUTABLE_FIELD" });
    expect(
      await cat.publish("ORG-1", structuredClone(profile("sim-bas-gateway")), {
        ...meta,
        reason: "",
      }),
    ).toMatchObject({ ok: false });
    expect((await cat.getActive("ORG-1", "sim-bas-gateway"))?.version).toBe(1);
  });

  it("scopes versions per organization and can roll back", async () => {
    const cat = make();
    expect((await cat.publish("ORG-1", structuredClone(profile("sim-bas-gateway")), meta)).ok).toBe(
      true,
    );
    expect((await cat.getActive("ORG-2", "sim-bas-gateway"))?.version).toBe(1);
    expect(await cat.getVersion("ORG-2", "sim-bas-gateway", 2)).toBeUndefined();
    expect(await cat.activate("ORG-1", "sim-bas-gateway", 1)).toBe(true);
    expect((await cat.getActive("ORG-1", "sim-bas-gateway"))?.version).toBe(1);
    expect(await cat.activate("ORG-1", "sim-bas-gateway", 7)).toBe(false);
  });
});
