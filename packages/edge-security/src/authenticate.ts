import { err, ok } from "@symbiosis/contracts";
import type { Result } from "@symbiosis/contracts";
import { nowSeconds } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { DeviceKeyStore, DeviceRecord, DeviceRegistry } from "@symbiosis/device-registry";
import type { ReplayGuard } from "./replay";
import { buildSigningMaterial, computeSignature, sha256Hex, signaturesMatch } from "./signing";

export const EDGE_AUTH_FAILURE_CODES = [
  "MISSING_HEADER",
  "MALFORMED_HEADER",
  "MALFORMED_SIGNATURE",
  "UNKNOWN_DEVICE",
  "DEVICE_DISABLED",
  "UNKNOWN_KEY_ID",
  "STALE_TIMESTAMP",
  "FUTURE_TIMESTAMP",
  "SIGNATURE_MISMATCH",
  "NONCE_REPLAY",
  "SEQUENCE_REUSE",
  "SEQUENCE_ROLLBACK",
] as const;
export type EdgeAuthFailureCode = (typeof EDGE_AUTH_FAILURE_CODES)[number];

/** Deliberately carries no key material or expected signature. */
export type EdgeAuthFailure = { readonly code: EdgeAuthFailureCode; readonly message: string };

export type EdgeAuthConfig = {
  /** A timestamp older than this many seconds is rejected as stale. */
  readonly maxAgeSeconds: number;
  /** A timestamp further ahead than this many seconds is rejected. */
  readonly maxFutureSkewSeconds: number;
};

export const DEFAULT_EDGE_AUTH_CONFIG: EdgeAuthConfig = {
  maxAgeSeconds: 300,
  maxFutureSkewSeconds: 60,
};

export type EdgeAuthDeps = {
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly replayGuard: ReplayGuard;
  readonly clock: Clock;
  readonly config?: EdgeAuthConfig;
};

export type EdgeAuthRequest = {
  readonly method: string;
  /** Request path without query string; this exact value is signed. */
  readonly path: string;
  /** Header names must be lower-case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The original request bytes; never a re-serialized parse. */
  readonly rawBody: Uint8Array;
};

export type AuthenticatedRequest = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly seq: number;
  readonly nonce: string;
  readonly timestampSeconds: number;
  readonly bodySha256: string;
  readonly device: DeviceRecord;
};

const fail = (code: EdgeAuthFailureCode, message: string) =>
  err<EdgeAuthFailure>({ code, message });

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[0-9a-fA-F]{64}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;
const SEQ = /^(0|[1-9][0-9]{0,14})$/;

/**
 * Authenticates a signed edge request. Order: header presence/format, timestamp window,
 * device and key lookup, HMAC verification over the raw body hash, then replay checks.
 * Replay state is only touched after the signature is proven valid, so unauthenticated
 * traffic cannot burn nonces or advance sequences.
 */
export async function authenticateEdgeRequest(
  deps: EdgeAuthDeps,
  request: EdgeAuthRequest,
): Promise<Result<AuthenticatedRequest, EdgeAuthFailure>> {
  const config = deps.config ?? DEFAULT_EDGE_AUTH_CONFIG;
  const h = request.headers;

  const missing = (name: string) => fail("MISSING_HEADER", `${name} is required`);
  const deviceId = h["x-device-id"];
  if (!deviceId) return missing("X-Device-Id");
  const keyId = h["x-key-id"];
  if (!keyId) return missing("X-Key-Id");
  const timestamp = h["x-timestamp"];
  if (!timestamp) return missing("X-Timestamp");
  const nonce = h["x-nonce"];
  if (!nonce) return missing("X-Nonce");
  const seq = h["x-seq"];
  if (!seq) return missing("X-Seq");
  const signature = h["x-signature"];
  if (!signature) return missing("X-Signature");

  if (deviceId.length > 128 || keyId.length > 128) {
    return fail("MALFORMED_HEADER", "X-Device-Id/X-Key-Id too long");
  }
  if (!TIMESTAMP.test(timestamp))
    return fail("MALFORMED_HEADER", "X-Timestamp must be epoch seconds");
  if (!NONCE.test(nonce)) return fail("MALFORMED_HEADER", "X-Nonce must be 16-64 [A-Za-z0-9_-]");
  if (!SEQ.test(seq)) return fail("MALFORMED_HEADER", "X-Seq must be a non-negative integer");
  if (!SIGNATURE.test(signature)) {
    return fail("MALFORMED_SIGNATURE", "X-Signature must be 64 hex characters");
  }

  const timestampSeconds = Number(timestamp);
  const now = nowSeconds(deps.clock);
  if (timestampSeconds < now - config.maxAgeSeconds) {
    return fail("STALE_TIMESTAMP", "timestamp is too old");
  }
  if (timestampSeconds > now + config.maxFutureSkewSeconds) {
    return fail("FUTURE_TIMESTAMP", "timestamp is too far in the future");
  }

  const device = await deps.registry.get(deviceId);
  if (device === undefined) return fail("UNKNOWN_DEVICE", "device is not registered");
  if (device.status !== "ACTIVE") return fail("DEVICE_DISABLED", "device is not active");
  if (keyId !== device.activeKeyId) return fail("UNKNOWN_KEY_ID", "key id is not the active key");
  const key = await deps.keys.getKey(deviceId, keyId);
  if (key === undefined || key.length !== 32) {
    return fail("UNKNOWN_KEY_ID", "no usable key for this key id");
  }

  const bodySha256 = sha256Hex(request.rawBody);
  const expected = computeSignature(
    key,
    buildSigningMaterial({
      method: request.method,
      path: request.path,
      timestamp,
      nonce,
      seq,
      bodySha256,
    }),
  );
  if (!signaturesMatch(expected, signature)) {
    return fail("SIGNATURE_MISMATCH", "signature verification failed");
  }

  const seqNumber = Number(seq);
  const decision = await deps.replayGuard.checkAndRecord({
    deviceId,
    keyId,
    nonce,
    seq: seqNumber,
    timestampSeconds,
    nowSeconds: now,
  });
  if (!decision.ok) return fail(decision.reason, "request rejected by replay protection");

  return ok({ deviceId, keyId, seq: seqNumber, nonce, timestampSeconds, bodySha256, device });
}
