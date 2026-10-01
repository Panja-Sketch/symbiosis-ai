import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Edge request signing (spec section 32). This format is the contract firmware must
 * reproduce byte for byte:
 *
 *   signing material = METHOD "\n" PATH "\n" TIMESTAMP "\n" NONCE "\n" SEQ "\n" SHA256(raw_body)
 *   signature        = lowercase-hex( HMAC-SHA256( raw 32-byte device key, material ) )
 *
 * - METHOD is upper-case; PATH is the request path with no query string.
 * - TIMESTAMP is Unix epoch seconds as a decimal integer; SEQ is a decimal integer.
 *   Both are signed exactly as they appear in the headers.
 * - SHA256(raw_body) is lowercase hex of the ORIGINAL request bytes, never of a parsed and
 *   re-serialized object.
 * - There is no trailing newline.
 */

/** Header names as sent on the wire (HTTP header names are case-insensitive). */
export const EDGE_HEADER_NAMES = {
  deviceId: "X-Device-Id",
  keyId: "X-Key-Id",
  timestamp: "X-Timestamp",
  nonce: "X-Nonce",
  seq: "X-Seq",
  signature: "X-Signature",
} as const;

export type SigningParts = {
  readonly method: string;
  readonly path: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly seq: string;
  /** Lowercase hex SHA-256 of the raw body bytes. */
  readonly bodySha256: string;
};

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function buildSigningMaterial(parts: SigningParts): string {
  return [
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.nonce,
    parts.seq,
    parts.bodySha256,
  ].join("\n");
}

export function computeSignature(key: Uint8Array, material: string): string {
  return createHmac("sha256", key).update(material, "utf8").digest("hex");
}

/** Timing-safe comparison of two hex signatures. Both must already be 64 hex characters. */
export function signaturesMatch(expectedHex: string, providedHex: string): boolean {
  const a = Buffer.from(expectedHex.toLowerCase(), "hex");
  const b = Buffer.from(providedHex.toLowerCase(), "hex");
  return a.length === b.length && a.length === 32 && timingSafeEqual(a, b);
}

export type SignRequestInput = {
  readonly key: Uint8Array;
  readonly method: string;
  readonly path: string;
  readonly deviceId: string;
  readonly keyId: string;
  /** Unix epoch seconds. */
  readonly timestampSeconds: number;
  readonly nonce: string;
  readonly seq: number;
  readonly body: Uint8Array;
};

/** Builds the six edge headers for a request. Used by the simulator and tests. */
export function signEdgeRequest(input: SignRequestInput): Record<string, string> {
  const timestamp = String(input.timestampSeconds);
  const seq = String(input.seq);
  const material = buildSigningMaterial({
    method: input.method,
    path: input.path,
    timestamp,
    nonce: input.nonce,
    seq,
    bodySha256: sha256Hex(input.body),
  });
  return {
    [EDGE_HEADER_NAMES.deviceId]: input.deviceId,
    [EDGE_HEADER_NAMES.keyId]: input.keyId,
    [EDGE_HEADER_NAMES.timestamp]: timestamp,
    [EDGE_HEADER_NAMES.nonce]: input.nonce,
    [EDGE_HEADER_NAMES.seq]: seq,
    [EDGE_HEADER_NAMES.signature]: computeSignature(input.key, material),
  };
}
