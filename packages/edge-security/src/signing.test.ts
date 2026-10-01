import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deviceKeyFromHex } from "@symbiosis/device-registry";
import {
  buildSigningMaterial,
  computeSignature,
  sha256Hex,
  signEdgeRequest,
  signaturesMatch,
} from "./signing";
import type { SigningParts } from "./signing";

const samples = join(import.meta.dirname, "..", "..", "..", "firmware-contracts", "sample-packets");
const vector = JSON.parse(readFileSync(join(samples, "signing-vector.json"), "utf8")) as Record<
  string,
  string
>;
const body = readFileSync(join(samples, vector.body_file as string));
const key = deviceKeyFromHex(vector.device_key_hex as string);

const base: SigningParts = {
  method: "POST",
  path: "/edge/v1/telemetry",
  timestamp: "1790000000",
  nonce: "vector_nonce_0001",
  seq: "42",
  bodySha256: sha256Hex(body),
};

describe("canonical signing material (firmware contract)", () => {
  it("is exactly METHOD, PATH, TIMESTAMP, NONCE, SEQ, SHA256(raw_body) joined by LF", () => {
    expect(buildSigningMaterial(base)).toBe(
      ["POST", "/edge/v1/telemetry", "1790000000", "vector_nonce_0001", "42", sha256Hex(body)].join(
        "\n",
      ),
    );
    expect(buildSigningMaterial(base).endsWith("\n")).toBe(false);
  });

  it("upper-cases the method", () => {
    expect(buildSigningMaterial({ ...base, method: "post" })).toBe(buildSigningMaterial(base));
  });

  it("reproduces the independently computed firmware test vector", () => {
    expect(sha256Hex(body)).toBe(vector.body_sha256);
    expect(buildSigningMaterial(base)).toBe(vector.signing_material);
    expect(computeSignature(key, buildSigningMaterial(base))).toBe(vector.x_signature);
  });

  it("signEdgeRequest emits the six spec headers with the vector signature", () => {
    const headers = signEdgeRequest({
      key,
      method: "POST",
      path: "/edge/v1/telemetry",
      deviceId: "DEV-SIM-001",
      keyId: "KEY-SIM-001",
      timestampSeconds: 1790000000,
      nonce: "vector_nonce_0001",
      seq: 42,
      body,
    });
    expect(Object.keys(headers).sort()).toEqual(
      ["X-Device-Id", "X-Key-Id", "X-Nonce", "X-Seq", "X-Signature", "X-Timestamp"].sort(),
    );
    expect(headers["X-Signature"]).toBe(vector.x_signature);
    expect(headers["X-Seq"]).toBe("42");
    expect(headers["X-Timestamp"]).toBe("1790000000");
  });
});

describe("signature properties", () => {
  const sign = (parts: SigningParts) => computeSignature(key, buildSigningMaterial(parts));

  it("is deterministic for identical inputs", () => {
    expect(sign(base)).toBe(sign({ ...base }));
  });

  it.each([
    ["method", { method: "PUT" }],
    ["path", { path: "/edge/v1/heartbeat" }],
    ["timestamp", { timestamp: "1790000001" }],
    ["nonce", { nonce: "vector_nonce_0002" }],
    ["seq", { seq: "43" }],
    ["body hash", { bodySha256: sha256Hex(new TextEncoder().encode("{}")) }],
  ])("changing the %s changes the signature", (_name, change) => {
    expect(sign({ ...base, ...change })).not.toBe(sign(base));
  });

  it("raw body bytes matter: JSON-equivalent but byte-different bodies hash differently", () => {
    const compact = new TextEncoder().encode('{"a":1,"b":2}');
    const spaced = new TextEncoder().encode('{ "b": 2, "a": 1 }');
    expect(sha256Hex(compact)).not.toBe(sha256Hex(spaced));
  });

  it("different keys produce different signatures", () => {
    const other = deviceKeyFromHex("f".repeat(64));
    expect(computeSignature(other, buildSigningMaterial(base))).not.toBe(sign(base));
  });

  it("compares signatures in constant time semantics and rejects bad lengths", () => {
    const good = sign(base);
    expect(signaturesMatch(good, good)).toBe(true);
    expect(signaturesMatch(good, good.toUpperCase())).toBe(true);
    expect(signaturesMatch(good, `${good.slice(0, 63)}0`)).toBe(good.endsWith("0"));
    expect(signaturesMatch(good, good.slice(0, 62))).toBe(false);
    expect(signaturesMatch(good, "")).toBe(false);
  });

  it("device keys must be exactly 64 hex characters", () => {
    expect(() => deviceKeyFromHex("abc")).toThrow();
    expect(() => deviceKeyFromHex("g".repeat(64))).toThrow();
    expect(deviceKeyFromHex("00".repeat(32)).length).toBe(32);
  });
});
