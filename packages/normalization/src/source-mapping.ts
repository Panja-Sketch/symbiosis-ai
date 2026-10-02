import { BOOLEAN_SIGNALS, CANONICAL_SIGNALS, SOURCE_MAPPING_SCHEMA } from "@symbiosis/contracts";
import { SOURCE_MAPPING_SOURCE_TYPES, TIMESTAMP_FORMATS } from "@symbiosis/contracts";
import type {
  CanonicalSignal,
  FieldTrace,
  MappingAsset,
  MappingUnit,
  RejectReason,
  SourceMappingDefinition,
  SourceMappingField,
  UnassessedObservation,
} from "@symbiosis/contracts";

/**
 * Declarative source-adapter mappings (S10, D-088).
 *
 * A mapping is DATA validated against a closed schema: field paths (dotted keys and `[n]` indexes
 * only), units from a fixed conversion table, asset lookups from a fixed map. There is no
 * expression, script, regular expression or callback anywhere in a definition, unknown keys are
 * rejected, and an unknown or incompatible unit fails closed at definition time and again at
 * payload time. This file contains no vendor name and no asset id.
 */

// ---------------------------------------------------------------------------------------------
// Canonical units and the closed conversion table
// ---------------------------------------------------------------------------------------------

export const CANONICAL_UNITS: Readonly<Record<CanonicalSignal, string>> = {
  temperature: "degC",
  relative_humidity: "%",
  vibration_rms: "m/s2",
  current: "A",
  load_percent: "%",
  equipment_running: "boolean",
  water_presence: "boolean",
  flow: "L/min",
  outdoor_temperature: "degC",
};

type Conversion = { readonly text: string; readonly apply: (value: number) => number };

const identity: Conversion = { text: "identity (same unit)", apply: (v) => v };
const linear = (scale: number): Conversion => ({
  text: `value x ${scale}`,
  apply: (v) => v * scale,
});

const TEMPERATURE: Readonly<Record<string, Conversion>> = {
  degC: identity,
  degF: { text: "(value - 32) x 5/9", apply: (v) => ((v - 32) * 5) / 9 },
  K: { text: "value - 273.15", apply: (v) => v - 273.15 },
};
const PERCENT: Readonly<Record<string, Conversion>> = {
  "%": identity,
  fraction: linear(100),
};

/** Units each canonical signal accepts, with the exact conversion. Anything else is incompatible. */
export const UNIT_CONVERSIONS: Readonly<
  Partial<Record<CanonicalSignal, Readonly<Record<string, Conversion>>>>
> = {
  temperature: TEMPERATURE,
  outdoor_temperature: TEMPERATURE,
  relative_humidity: PERCENT,
  load_percent: PERCENT,
  vibration_rms: { "m/s2": identity, g: linear(9.80665), "mm/s2": linear(0.001) },
  current: { A: identity, mA: linear(0.001), kA: linear(1000) },
  flow: { "L/min": identity, "m3/h": linear(1000 / 60), gpm: linear(3.785411784) },
};

/** Velocity units are a different quantity from acceleration: there is no safe conversion. */
const VELOCITY_UNITS: readonly string[] = ["mm/s", "m/s", "in/s", "cm/s"];

export function acceptedUnits(signal: CanonicalSignal): readonly string[] {
  return Object.keys(UNIT_CONVERSIONS[signal] ?? {});
}

export type UnitCheck =
  | { readonly ok: true; readonly conversion: Conversion }
  | { readonly ok: false; readonly detail: string };

export function conversionFor(signal: CanonicalSignal, unit: string): UnitCheck {
  const table = UNIT_CONVERSIONS[signal];
  const conversion =
    table !== undefined && Object.prototype.hasOwnProperty.call(table, unit)
      ? table[unit]
      : undefined;
  if (conversion !== undefined) return { ok: true, conversion };
  if (signal === "vibration_rms" && VELOCITY_UNITS.includes(unit)) {
    return {
      ok: false,
      detail: `${unit} is a velocity; ${signal} is an acceleration (${CANONICAL_UNITS[signal]}). There is no safe conversion.`,
    };
  }
  return {
    ok: false,
    detail: `${unit} cannot be converted to ${CANONICAL_UNITS[signal]} for ${signal} (accepted: ${acceptedUnits(signal).join(", ") || "none"}).`,
  };
}

// ---------------------------------------------------------------------------------------------
// Paths: dotted keys and [n] indexes, resolved over own properties only
// ---------------------------------------------------------------------------------------------

const PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*|\[\d{1,3}\])*$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const MAX_PATH_LENGTH = 200;

export type PathToken = string | number;

export function parsePath(path: string): readonly PathToken[] | undefined {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path)) {
    return undefined;
  }
  const tokens: PathToken[] = [];
  for (const m of path.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)|\[(\d{1,3})\]/g)) {
    if (m[1] !== undefined) {
      if (FORBIDDEN_KEYS.has(m[1])) return undefined;
      tokens.push(m[1]);
    } else if (m[2] !== undefined) tokens.push(Number(m[2]));
  }
  return tokens;
}

export function resolvePath(root: unknown, path: string): unknown {
  const tokens = parsePath(path);
  if (tokens === undefined) return undefined;
  let cur: unknown = root;
  for (const t of tokens) {
    if (typeof t === "number") {
      if (!Array.isArray(cur) || t >= cur.length) return undefined;
      cur = cur[t];
    } else {
      if (
        typeof cur !== "object" ||
        cur === null ||
        Array.isArray(cur) ||
        !Object.prototype.hasOwnProperty.call(cur, t)
      ) {
        return undefined;
      }
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Definition validation (fail closed)
// ---------------------------------------------------------------------------------------------

export type MappingParseResult =
  | { readonly ok: true; readonly value: SourceMappingDefinition }
  | { readonly ok: false; readonly issues: readonly string[] };

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SOURCE_ID_KEY = /^[\x20-\x7e]{1,64}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

function unknownKeys(obj: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(obj).filter((k) => !allowed.includes(k));
}

export const MAX_FIELDS = 32;
export const MAX_MAP_ENTRIES = 50;

function checkAsset(a: unknown, where: string, issues: string[]): void {
  if (!isRecord(a)) {
    issues.push(`${where} must be an object`);
    return;
  }
  for (const k of unknownKeys(a, ["path", "map", "fixed"]))
    issues.push(`${where}.${k} is not allowed`);
  const { path, map, fixed } = a as Record<string, unknown>;
  if (fixed !== undefined) {
    if (typeof fixed !== "string" || !ASSET_ID.test(fixed))
      issues.push(`${where}.fixed is not a valid asset id`);
    if (path !== undefined || map !== undefined)
      issues.push(`${where}: fixed excludes path and map`);
  } else {
    if (typeof path !== "string" || parsePath(path) === undefined)
      issues.push(`${where}.path is not a valid path`);
    if (!isRecord(map) || Object.keys(map).length === 0) {
      issues.push(`${where}.map is required with path (an unmapped source asset is never guessed)`);
    } else {
      if (Object.keys(map).length > MAX_MAP_ENTRIES)
        issues.push(`${where}.map has too many entries`);
      for (const [k, v] of Object.entries(map)) {
        if (!SOURCE_ID_KEY.test(k) || FORBIDDEN_KEYS.has(k))
          issues.push(`${where}.map key is not allowed`);
        if (typeof v !== "string" || !ASSET_ID.test(v))
          issues.push(`${where}.map value is not a valid asset id`);
      }
    }
  }
}

/** Validates an untrusted definition. Strict: unknown keys, bad paths and bad units are all errors. */
export function parseSourceMapping(value: unknown): MappingParseResult {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ["definition must be a JSON object"] };
  for (const k of unknownKeys(value, [
    "schema",
    "profileId",
    "version",
    "displayName",
    "vendorLabel",
    "description",
    "sourceType",
    "synthetic",
    "timestamp",
    "asset",
    "samples",
    "fields",
  ])) {
    issues.push(`unknown key "${k}" (mappings are data only; there is no expression language)`);
  }
  if (value.schema !== SOURCE_MAPPING_SCHEMA)
    issues.push(`schema must be ${SOURCE_MAPPING_SCHEMA}`);
  if (typeof value.profileId !== "string" || !PROFILE_ID.test(value.profileId)) {
    issues.push("profileId must be lower-case letters, digits and hyphens (3-64 characters)");
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    issues.push("version must be a positive integer");
  }
  if (!text(value.displayName, 80)) issues.push("displayName is required (max 80 characters)");
  if (!text(value.vendorLabel, 80)) issues.push("vendorLabel is required (max 80 characters)");
  if (!text(value.description, 400)) issues.push("description is required (max 400 characters)");
  if (!(SOURCE_MAPPING_SOURCE_TYPES as readonly unknown[]).includes(value.sourceType)) {
    issues.push(`sourceType must be one of ${SOURCE_MAPPING_SOURCE_TYPES.join(", ")}`);
  }
  if (typeof value.synthetic !== "boolean") issues.push("synthetic must be true or false");
  else if (value.synthetic !== (value.sourceType === "SIMULATOR")) {
    issues.push(
      "a synthetic profile must use sourceType SIMULATOR, and SIMULATOR must be synthetic",
    );
  }

  const ts = value.timestamp;
  if (!isRecord(ts)) issues.push("timestamp is required");
  else {
    for (const k of unknownKeys(ts, ["path", "format"]))
      issues.push(`timestamp.${k} is not allowed`);
    if (typeof ts.path !== "string" || parsePath(ts.path) === undefined) {
      issues.push("timestamp.path is not a valid path");
    }
    if (!(TIMESTAMP_FORMATS as readonly unknown[]).includes(ts.format)) {
      issues.push(`timestamp.format must be one of ${TIMESTAMP_FORMATS.join(", ")}`);
    }
  }

  if (value.asset === undefined) issues.push("asset is required");
  else checkAsset(value.asset, "asset", issues);

  if (value.samples !== undefined) {
    if (!isRecord(value.samples)) issues.push("samples must be an object");
    else {
      for (const k of unknownKeys(value.samples, ["path"]))
        issues.push(`samples.${k} is not allowed`);
      const p = value.samples.path;
      if (typeof p !== "string" || parsePath(p) === undefined)
        issues.push("samples.path is not a valid path");
    }
  }

  if (!Array.isArray(value.fields) || value.fields.length === 0) {
    issues.push("fields must be a non-empty list");
  } else if (value.fields.length > MAX_FIELDS) {
    issues.push(`fields must not exceed ${MAX_FIELDS}`);
  } else {
    const seen = new Set<string>();
    value.fields.forEach((f: unknown, i: number) => {
      const w = `fields[${i}]`;
      if (!isRecord(f)) {
        issues.push(`${w} must be an object`);
        return;
      }
      for (const k of unknownKeys(f, [
        "signal",
        "asset",
        "path",
        "valueType",
        "unit",
        "enum",
        "bounds",
        "note",
      ])) {
        issues.push(`${w}.${k} is not allowed`);
      }
      const signal = f.signal as CanonicalSignal;
      if (!(CANONICAL_SIGNALS as readonly unknown[]).includes(signal)) {
        issues.push(`${w}.signal is not a canonical signal`);
        return;
      }
      if (seen.has(signal))
        issues.push(`${w}: signal ${signal} is mapped twice (one source per signal per profile)`);
      seen.add(signal);
      if (typeof f.path !== "string" || parsePath(f.path) === undefined)
        issues.push(`${w}.path is not a valid path`);
      const isBool = BOOLEAN_SIGNALS.includes(signal);
      if (f.valueType !== (isBool ? "boolean" : "number")) {
        issues.push(`${w}.valueType must be ${isBool ? "boolean" : "number"} for ${signal}`);
      }
      if (f.asset !== undefined) checkAsset(f.asset, `${w}.asset`, issues);
      if (isBool) {
        if (f.unit !== undefined) issues.push(`${w}.unit is not allowed for a boolean signal`);
        if (f.bounds !== undefined) issues.push(`${w}.bounds is not allowed for a boolean signal`);
        if (f.enum !== undefined) {
          if (
            !isRecord(f.enum) ||
            Object.keys(f.enum).length === 0 ||
            Object.keys(f.enum).length > 20
          ) {
            issues.push(`${w}.enum must list 1-20 values`);
          } else {
            for (const [k, v] of Object.entries(f.enum)) {
              if (!SOURCE_ID_KEY.test(k) || FORBIDDEN_KEYS.has(k) || typeof v !== "boolean") {
                issues.push(`${w}.enum entries must map text to true or false`);
              }
            }
          }
        }
      } else {
        if (f.enum !== undefined) issues.push(`${w}.enum is only for boolean signals`);
        const u = f.unit;
        if (!isRecord(u)) issues.push(`${w}.unit is required for a numeric signal`);
        else {
          for (const k of unknownKeys(u, ["fixed", "path", "allowed"]))
            issues.push(`${w}.unit.${k} is not allowed`);
          const units: unknown[] = [];
          if (u.fixed !== undefined) {
            if (u.path !== undefined || u.allowed !== undefined)
              issues.push(`${w}.unit: fixed excludes path and allowed`);
            units.push(u.fixed);
          } else {
            if (typeof u.path !== "string" || parsePath(u.path) === undefined)
              issues.push(`${w}.unit.path is not a valid path`);
            if (!Array.isArray(u.allowed) || u.allowed.length === 0 || u.allowed.length > 10) {
              issues.push(`${w}.unit.allowed must list 1-10 units`);
            } else units.push(...u.allowed);
          }
          for (const unit of units) {
            if (typeof unit !== "string") {
              issues.push(`${w}.unit contains a non-text unit`);
              continue;
            }
            const check = conversionFor(signal, unit);
            if (!check.ok) issues.push(`${w}: ${check.detail}`);
          }
        }
        if (f.bounds !== undefined) {
          const b = f.bounds;
          if (
            !isRecord(b) ||
            typeof b.min !== "number" ||
            typeof b.max !== "number" ||
            !Number.isFinite(b.min) ||
            !Number.isFinite(b.max) ||
            b.min >= b.max
          ) {
            issues.push(`${w}.bounds needs finite numbers with min < max`);
          } else
            for (const k of unknownKeys(b, ["min", "max"]))
              issues.push(`${w}.bounds.${k} is not allowed`);
        }
      }
      if (f.note !== undefined && !text(f.note, 200))
        issues.push(`${w}.note must be short plain text`);
    });
  }
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: value as unknown as SourceMappingDefinition };
}

// ---------------------------------------------------------------------------------------------
// Applying a definition to a payload
// ---------------------------------------------------------------------------------------------

export type AdaptContext = {
  readonly organizationId: string;
  readonly facilityId: string;
  readonly deviceId: string;
  readonly expectedSignals: readonly CanonicalSignal[];
  /** Every asset the authenticated device is registered for; placement elsewhere is rejected. */
  readonly allowedAssetIds: readonly string[];
  readonly receivedAt: string;
};

export type AdaptOutcome = {
  readonly observations: readonly UnassessedObservation[];
  readonly fields: readonly FieldTrace[];
  /** Observed instant of the first sample that had a valid timestamp. */
  readonly observedAt?: string;
  readonly issues: readonly string[];
};

export const MAX_SAMPLES = 100;

export function adapterName(def: Pick<SourceMappingDefinition, "profileId" | "version">): string {
  return `${def.profileId}@v${def.version}`;
}

function parseTimestamp(raw: unknown, format: SourceMappingDefinition["timestamp"]["format"]) {
  let ms: number | undefined;
  if (format === "ISO_8601") {
    if (
      typeof raw === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)
    ) {
      ms = Date.parse(raw);
    }
  } else if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    ms = format === "EPOCH_SECONDS" ? raw * 1000 : raw;
  }
  if (
    ms === undefined ||
    Number.isNaN(ms) ||
    ms < Date.UTC(2000, 0, 1) ||
    ms > Date.UTC(2100, 0, 1)
  ) {
    return undefined;
  }
  return new Date(ms).toISOString();
}

type AssetResolution =
  | { readonly ok: true; readonly assetId: string; readonly source?: string }
  | {
      readonly ok: false;
      readonly reason: RejectReason;
      readonly detail: string;
      readonly source?: string;
    };

function resolveAsset(a: MappingAsset, sample: unknown): AssetResolution {
  if (a.fixed !== undefined) return { ok: true, assetId: a.fixed };
  const raw = resolvePath(sample, a.path ?? "");
  if (typeof raw !== "string" && typeof raw !== "number") {
    return { ok: false, reason: "UNMAPPED_ASSET", detail: `no asset identifier at ${a.path}` };
  }
  const key = String(raw);
  const map = a.map ?? {};
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    return {
      ok: false,
      reason: "UNMAPPED_ASSET",
      detail: `source asset "${key}" is not in the mapping`,
      source: key,
    };
  }
  return { ok: true, assetId: map[key] as string, source: key };
}

const traceValue = (v: unknown): FieldTrace["sourceValue"] =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? v
    : v === undefined
      ? null
      : null;

/**
 * Applies a validated mapping to one vendor payload. Pure and deterministic: the same payload and
 * definition always give the same observations and the same field-by-field trace. Nothing is
 * guessed: every reading that cannot be accepted is reported with its reason.
 */
export function applySourceMapping(
  def: SourceMappingDefinition,
  payload: unknown,
  ctx: AdaptContext,
): AdaptOutcome {
  const observations: UnassessedObservation[] = [];
  const fields: FieldTrace[] = [];
  const issues: string[] = [];
  let firstObservedAt: string | undefined;

  let samples: readonly unknown[];
  if (def.samples !== undefined) {
    const arr = resolvePath(payload, def.samples.path);
    if (!Array.isArray(arr) || arr.length === 0) {
      issues.push(`samples are missing at ${def.samples.path}`);
      samples = [];
    } else if (arr.length > MAX_SAMPLES) {
      issues.push(`more than ${MAX_SAMPLES} samples`);
      samples = arr.slice(0, MAX_SAMPLES);
    } else samples = arr;
  } else samples = [payload];

  for (const sample of samples) {
    const observedAt = parseTimestamp(
      resolvePath(sample, def.timestamp.path),
      def.timestamp.format,
    );
    if (observedAt !== undefined && firstObservedAt === undefined) firstObservedAt = observedAt;
    for (const f of def.fields)
      fields.push(applyField(def, f, sample, observedAt, ctx, observations));
    if (observedAt === undefined)
      issues.push(`invalid or missing timestamp at ${def.timestamp.path}`);
  }
  return {
    observations,
    fields,
    ...(firstObservedAt !== undefined && { observedAt: firstObservedAt }),
    issues,
  };
}

function applyField(
  def: SourceMappingDefinition,
  f: SourceMappingField,
  sample: unknown,
  observedAt: string | undefined,
  ctx: AdaptContext,
  out: UnassessedObservation[],
): FieldTrace {
  const canonicalUnit = CANONICAL_UNITS[f.signal];
  const rawValue = resolvePath(sample, f.path);
  const base = {
    signal: f.signal,
    sourcePath: f.path,
    sourceValue: traceValue(rawValue),
    canonicalUnit,
  };
  const reject = (
    reason: RejectReason,
    detail: string,
    extra: Partial<FieldTrace> = {},
  ): FieldTrace => ({
    ...base,
    conversion: extra.conversion ?? "not applied",
    ...extra,
    status: "REJECTED",
    reason,
    detail,
  });

  if (observedAt === undefined)
    return reject("INVALID_TIMESTAMP", "the sample has no valid timestamp");
  if (rawValue === undefined) return reject("MISSING_FIELD", `nothing at ${f.path}`);

  const placement = resolveAsset(f.asset ?? def.asset, sample);
  if (!placement.ok) {
    return reject(placement.reason, placement.detail, {
      ...(placement.source !== undefined && { sourceAsset: placement.source }),
    });
  }
  const assetTrace = {
    ...(placement.source !== undefined && { sourceAsset: placement.source }),
    assetId: placement.assetId,
  };
  if (!ctx.allowedAssetIds.includes(placement.assetId)) {
    return reject(
      "ASSET_NOT_PERMITTED",
      `device is not registered for asset ${placement.assetId}`,
      assetTrace,
    );
  }
  if (!ctx.expectedSignals.includes(f.signal)) {
    return reject("SIGNAL_NOT_EXPECTED", `device does not declare ${f.signal}`, assetTrace);
  }

  let value: number | boolean;
  let conversionText = "identity";
  let sourceUnit: string | undefined;
  if (f.valueType === "boolean") {
    if (typeof rawValue === "boolean") value = rawValue;
    else if (
      typeof rawValue === "string" &&
      f.enum !== undefined &&
      Object.prototype.hasOwnProperty.call(f.enum, rawValue)
    ) {
      value = f.enum[rawValue] as boolean;
      conversionText = `enum "${rawValue}" -> ${String(value)}`;
    } else if (typeof rawValue === "string") {
      return reject("UNKNOWN_ENUM_VALUE", `"${rawValue}" is not a listed value`, assetTrace);
    } else {
      return reject("VALUE_TYPE_MISMATCH", "expected a boolean", assetTrace);
    }
  } else {
    if (typeof rawValue !== "number")
      return reject("VALUE_TYPE_MISMATCH", "expected a number", assetTrace);
    if (!Number.isFinite(rawValue))
      return reject("INVALID_VALUE", "not a finite number", assetTrace);
    const u = f.unit as MappingUnit;
    if ("fixed" in u) sourceUnit = u.fixed;
    else {
      const unitRaw = resolvePath(sample, u.path);
      if (typeof unitRaw !== "string" || !u.allowed.includes(unitRaw)) {
        return reject(
          "INCOMPATIBLE_UNIT",
          typeof unitRaw === "string"
            ? ((conversionFor(f.signal, unitRaw) as { detail?: string }).detail ??
                `${unitRaw} is not an allowed unit for this field`)
            : `no unit at ${u.path}`,
          { ...assetTrace, ...(typeof unitRaw === "string" && { sourceUnit: unitRaw }) },
        );
      }
      sourceUnit = unitRaw;
    }
    const check = conversionFor(f.signal, sourceUnit);
    if (!check.ok) {
      return reject("INCOMPATIBLE_UNIT", check.detail, { ...assetTrace, sourceUnit });
    }
    conversionText = check.conversion.text;
    value = check.conversion.apply(rawValue);
    if (!Number.isFinite(value))
      return reject("INVALID_VALUE", "conversion is not finite", assetTrace);
    if (f.bounds !== undefined && (value < f.bounds.min || value > f.bounds.max)) {
      return reject(
        "OUT_OF_BOUNDS",
        `${value} ${canonicalUnit} is outside ${f.bounds.min}..${f.bounds.max}`,
        { ...assetTrace, sourceUnit, conversion: conversionText },
      );
    }
  }

  out.push({
    observationId: `OBS-${ctx.deviceId}-${f.signal}-${observedAt}`,
    organizationId: ctx.organizationId,
    facilityId: ctx.facilityId,
    assetId: placement.assetId,
    deviceId: ctx.deviceId,
    signal: f.signal,
    value,
    unit: canonicalUnit,
    observedAt,
    receivedAt: ctx.receivedAt,
    sourceType: def.sourceType,
    sourceAdapter: adapterName(def),
  });
  return {
    ...base,
    ...(sourceUnit !== undefined && { sourceUnit }),
    conversion: conversionText,
    ...assetTrace,
    canonicalValue: value,
    status: "ACCEPTED",
  };
}

/** Static description of a mapping for display: each field with every unit it accepts. */
export function describeMapping(def: SourceMappingDefinition) {
  return def.fields.map((f) => {
    const units =
      f.valueType === "boolean"
        ? []
        : (f.unit !== undefined && "fixed" in f.unit
            ? [f.unit.fixed]
            : (f.unit?.allowed ?? [])
          ).map((unit) => {
            const c = conversionFor(f.signal, unit);
            return { unit, conversion: c.ok ? c.conversion.text : c.detail };
          });
    return {
      signal: f.signal,
      sourcePath: f.path,
      valueType: f.valueType,
      canonicalUnit: CANONICAL_UNITS[f.signal],
      units,
      ...(f.enum !== undefined && { enum: f.enum }),
      ...(f.bounds !== undefined && { bounds: f.bounds }),
      asset: f.asset ?? def.asset,
    };
  });
}
