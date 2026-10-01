import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson, toJsonValue } from "./canonical";
import { sha256OfCanonical, sha256OfText } from "./hash";
import { InMemoryEvidenceObjectStore, evidenceObjectKey } from "./store";

describe("canonical serialization symbiosis-canonical-json.v1", () => {
  it("sorts object keys by code unit, recursively, and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ B: 1, a: 2, "": 3, é: 4 })).toBe('{"":3,"B":1,"a":2,"é":4}');
  });

  it("gives the same bytes whatever the insertion order", () => {
    const a = { x: 1, y: { p: [1, 2], q: null }, z: "s" };
    const b = { z: "s", y: { q: null, p: [1, 2] }, x: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256OfCanonical(a)).toBe(sha256OfCanonical(b));
  });

  it("keeps array order (order is data)", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("omits undefined properties as if absent, but refuses an undefined array element", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalJson(undefined)).toThrow(CanonicalizationError);
  });

  it("writes numbers in the shortest round-trip form and normalizes negative zero", () => {
    expect(canonicalJson([0, -0, 1.5, 1e21, 0.1 + 0.2, 100])).toBe(
      "[0,0,1.5,1e+21,0.30000000000000004,100]",
    );
  });

  it("rejects anything that is not plain JSON, never coercing it", () => {
    for (const bad of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      new Date(0),
      new Map(),
      new Set(),
      () => 1,
      Symbol("s"),
      10n,
      new (class Foo {})(),
    ]) {
      expect(() => canonicalJson({ bad }), String(bad)).toThrow(CanonicalizationError);
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
    // a shared (non-cyclic) reference is fine
    const shared = { v: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"v":1},"b":{"v":1}}');
  });

  it("escapes strings like JSON and is independent of locale or timezone", () => {
    expect(canonicalJson('a"b\\c\n ')).toBe(JSON.stringify('a"b\\c\n '));
    const iso = "2026-10-01T00:00:00.000Z";
    const before = canonicalJson({ at: iso });
    const tz = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    expect(canonicalJson({ at: iso })).toBe(before);
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  });

  it("toJsonValue returns a detached plain-JSON copy", () => {
    const src = { a: [1, { b: 2 }], c: undefined };
    const copy = toJsonValue(src);
    expect(copy).toEqual({ a: [1, { b: 2 }] });
    (copy as { a: unknown[] }).a.push(9);
    expect(src.a).toHaveLength(2);
  });

  it("SHA-256 matches the known answers", () => {
    expect(sha256OfText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256OfText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256OfCanonical({ b: 1, a: 2 })).toBe(sha256OfText('{"a":2,"b":1}'));
    // one byte of difference changes the hash
    expect(sha256OfText("abc")).not.toBe(sha256OfText("abd"));
  });
});

describe("evidence object store", () => {
  it("never overwrites", async () => {
    const s = new InMemoryEvidenceObjectStore();
    expect(await s.putIfAbsent("k", "one")).toBe(true);
    expect(await s.putIfAbsent("k", "two")).toBe(false);
    expect(await s.get("k")).toBe("one");
    expect(await s.get("missing")).toBeUndefined();
  });

  it("keys are tenant-prefixed", () => {
    expect(evidenceObjectKey("ORG-1", "EVP-9")).toBe("evidence/ORG-1/EVP-9.json");
  });
});
