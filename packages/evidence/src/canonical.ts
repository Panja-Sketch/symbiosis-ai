import type { JsonValue } from "@symbiosis/contracts";

/**
 * Canonical serialization `symbiosis-canonical-json.v1`. The same value always yields the same
 * bytes, whatever the object insertion order, locale or timezone:
 *
 * - UTF-8 text, no whitespace between tokens.
 * - Object keys sorted by UTF-16 code unit order (the default `Array.prototype.sort` on strings);
 *   properties whose value is `undefined` are omitted, exactly as if absent.
 * - Arrays keep their order; an `undefined` array element is an error (JSON would turn it into
 *   `null`, which would be an ambiguity).
 * - Strings use the standard JSON escaping; numbers must be finite and use the ECMAScript
 *   shortest round-trip form (`-0` is written `0`); booleans and `null` as usual.
 * - Anything that is not plain JSON (Date, Map, Set, bigint, symbol, function, class instance,
 *   NaN, Infinity, cycles) is rejected, never coerced.
 *
 * Timestamps are not interpreted: callers pass ISO-8601 UTC strings, which this function treats
 * as ordinary strings, so no timezone or locale can influence the output.
 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function write(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalizationError(`non-finite number at ${path}`);
      }
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw new CanonicalizationError(`unsupported ${typeof value} at ${path}`);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError(`cycle at ${path}`);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return `[${obj
        .map((item: unknown, i) => {
          if (item === undefined)
            throw new CanonicalizationError(`undefined element at ${path}[${i}]`);
          return write(item, `${path}[${i}]`, seen);
        })
        .join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      throw new CanonicalizationError(`non-plain object at ${path}`);
    }
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${write(obj[k], `${path}.${k}`, seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/** The canonical text of a value; hash its UTF-8 bytes. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new CanonicalizationError("undefined at $");
  return write(value, "$", new Set());
}

/** A plain-JSON deep copy of a record, normalised through the canonical form. */
export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}
