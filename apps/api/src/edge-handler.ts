import { EDGE_PATHS, parseEdgeHeartbeat, parseEdgeTelemetry } from "@symbiosis/contracts";
import { nowIso } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { DeviceKeyStore, DeviceRecord, DeviceRegistry } from "@symbiosis/device-registry";
import type { AdapterCatalog } from "@symbiosis/normalization";
import { authenticateEdgeRequest } from "@symbiosis/edge-security";
import type { EdgeAuthConfig, EdgeAuthFailureCode, ReplayGuard } from "@symbiosis/edge-security";
import { createEnvelope } from "@symbiosis/event-bus";
import type { EventBus, IdGenerator } from "@symbiosis/event-bus";

/** Transport-neutral request: the raw body bytes are what the signature covers. */
export type EdgeRequest = {
  readonly method: string;
  /** Request target as received, e.g. "/edge/v1/telemetry". */
  readonly target: string;
  /** Header names must be lower-case. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly rawBody: Uint8Array;
};

export type EdgeResponse = {
  readonly status: number;
  /** A string body is sent as-is with `contentType`; anything else is JSON. */
  readonly body: unknown;
  readonly contentType?: string;
  /** Extra response headers (e.g. `Location` for the minimal UI form redirects). */
  readonly headers?: Readonly<Record<string, string>>;
};

export type EdgeLogEntry = {
  readonly level: "info" | "warn";
  readonly message: string;
  /** Never contains keys, signatures or raw bodies. */
  readonly fields?: Readonly<Record<string, string | number>>;
};

export type EdgeApiDeps = {
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly replayGuard: ReplayGuard;
  readonly bus: EventBus;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly authConfig?: EdgeAuthConfig;
  /**
   * Versioned source-adapter catalog (D-088). Present: `/edge/v1/source` exists and accepts a vendor
   * payload from a device bound to a source profile. Absent: that endpoint answers 404.
   */
  readonly adapters?: AdapterCatalog;
  readonly log?: (entry: EdgeLogEntry) => void;
};

const AUTH_STATUS: Record<EdgeAuthFailureCode, number> = {
  MISSING_HEADER: 400,
  MALFORMED_HEADER: 400,
  MALFORMED_SIGNATURE: 400,
  UNKNOWN_DEVICE: 401,
  DEVICE_DISABLED: 403,
  UNKNOWN_KEY_ID: 401,
  STALE_TIMESTAMP: 401,
  FUTURE_TIMESTAMP: 401,
  SIGNATURE_MISMATCH: 401,
  NONCE_REPLAY: 409,
  SEQUENCE_REUSE: 409,
  SEQUENCE_ROLLBACK: 409,
};

const error = (status: number, code: string, message: string, issues?: readonly string[]) => ({
  status,
  body: { error: { code, message, ...(issues !== undefined && { issues }) } },
});

function decodeJson(raw: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) };
  } catch {
    return { ok: false };
  }
}

/**
 * Local edge API (spec sections 32-33). Authentication runs over the ORIGINAL request bytes;
 * the body is parsed only after the signature is proven valid. Telemetry events are emitted
 * only for authenticated, schema-valid requests, so unauthenticated traffic cannot flood the
 * bus. This handler knows nothing about HTTP frameworks or cloud services.
 */
export function createEdgeHandler(
  deps: EdgeApiDeps,
): (request: EdgeRequest) => Promise<EdgeResponse> {
  const log = deps.log ?? (() => undefined);

  return async (request) => {
    const queryAt = request.target.indexOf("?");
    if (queryAt !== -1) {
      return error(400, "INVALID_REQUEST", "query strings are not allowed on edge endpoints");
    }
    const path = request.target;
    const knownPath =
      path === EDGE_PATHS.telemetry ||
      path === EDGE_PATHS.heartbeat ||
      (path === EDGE_PATHS.source && deps.adapters !== undefined);
    if (!knownPath) return error(404, "NOT_FOUND", "unknown endpoint");
    if (request.method.toUpperCase() !== "POST") {
      return error(405, "METHOD_NOT_ALLOWED", "edge endpoints accept POST only");
    }

    const auth = await authenticateEdgeRequest(
      {
        registry: deps.registry,
        keys: deps.keys,
        replayGuard: deps.replayGuard,
        clock: deps.clock,
        ...(deps.authConfig !== undefined && { config: deps.authConfig }),
      },
      {
        method: request.method,
        path,
        headers: request.headers,
        rawBody: request.rawBody,
      },
    );
    if (!auth.ok) {
      log({
        level: "warn",
        message: "edge authentication failed",
        fields: { code: auth.error.code, path },
      });
      return error(AUTH_STATUS[auth.error.code], auth.error.code, auth.error.message);
    }
    const { deviceId, keyId, seq, bodySha256, device } = auth.value;

    const decoded = decodeJson(request.rawBody);
    if (!decoded.ok) return error(400, "MALFORMED_BODY", "body is not valid UTF-8 JSON");

    const receivedAt = nowIso(deps.clock);

    if (path === EDGE_PATHS.heartbeat) {
      const parsed = parseEdgeHeartbeat(decoded.value);
      if (!parsed.ok) return error(400, "INVALID_PAYLOAD", "invalid heartbeat", parsed.error);
      if (parsed.value.device_id !== deviceId) {
        return error(
          403,
          "DEVICE_ID_MISMATCH",
          "body device_id does not match authenticated device",
        );
      }
      await deps.registry.recordSeen(deviceId, {
        seenAt: receivedAt,
        firmwareVersion: parsed.value.firmware_version,
        health: parsed.value.health,
      });
      return { status: 200, body: { status: "ok", receivedAt } };
    }

    if (path === EDGE_PATHS.source)
      return acceptSource({
        deps,
        device,
        deviceId,
        keyId,
        seq,
        bodySha256,
        receivedAt,
        byteLength: request.rawBody.byteLength,
        payload: decoded.value,
        log,
      });

    const parsed = parseEdgeTelemetry(decoded.value);
    if (!parsed.ok) return error(400, "INVALID_PAYLOAD", "invalid telemetry", parsed.error);
    const telemetry = parsed.value;
    if (telemetry.device_id !== deviceId) {
      return error(403, "DEVICE_ID_MISMATCH", "body device_id does not match authenticated device");
    }

    await deps.registry.recordSeen(deviceId, {
      seenAt: receivedAt,
      firmwareVersion: telemetry.firmware_version,
    });
    const current = (await deps.registry.get(deviceId)) ?? device;

    const correlationId = deps.ids.next("CORR");
    const base = {
      correlationId,
      organizationId: device.organizationId,
      facilityId: device.facilityId,
      occurredAt: receivedAt,
      producer: "api" as const,
    };
    const received = createEnvelope(deps.ids, {
      ...base,
      type: "telemetry.received.v1",
      causationId: null,
      payload: {
        deviceId,
        keyId,
        seq,
        bodySha256,
        byteLength: request.rawBody.byteLength,
        receivedAt,
      },
    });
    const authenticated = createEnvelope(deps.ids, {
      ...base,
      type: "telemetry.authenticated.v1",
      causationId: received.event_id,
      payload: {
        deviceId,
        keyId,
        seq,
        receivedAt,
        assetId: device.assetId,
        ...(device.assetMapping !== undefined && { assetMapping: device.assetMapping }),
        expectedSignals: device.expectedSignals,
        deviceHealth: current.health,
        telemetry,
      },
    });
    await deps.bus.publish(received);
    await deps.bus.publish(authenticated);

    log({ level: "info", message: "telemetry accepted", fields: { deviceId, seq } });
    return { status: 202, body: { status: "accepted", correlationId, receivedAt } };
  };
}

/**
 * A vendor payload from an authenticated device. The device record (never the request) names the
 * source profile; the active version is pinned into the event so the worker interprets the payload
 * exactly as it was accepted, and the raw JSON travels unchanged.
 */
async function acceptSource(input: {
  readonly deps: EdgeApiDeps;
  readonly device: DeviceRecord;
  readonly deviceId: string;
  readonly keyId: string;
  readonly seq: number;
  readonly bodySha256: string;
  readonly receivedAt: string;
  readonly byteLength: number;
  readonly payload: unknown;
  readonly log: (entry: EdgeLogEntry) => void;
}): Promise<EdgeResponse> {
  const { deps, device, deviceId, keyId, seq, bodySha256, receivedAt, payload } = input;
  const profile = device.sourceProfile;
  if (profile === undefined) {
    return error(400, "NO_SOURCE_PROFILE", "this device is not bound to a source-adapter profile");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return error(400, "INVALID_PAYLOAD", "a source payload must be a JSON object");
  }
  const definition = await deps.adapters?.getActive(device.organizationId, profile.profileId);
  if (definition === undefined) {
    return error(503, "PROFILE_UNAVAILABLE", "the device's source-adapter profile is unavailable");
  }
  await deps.registry.recordSeen(deviceId, { seenAt: receivedAt });
  const current = (await deps.registry.get(deviceId)) ?? device;
  const correlationId = deps.ids.next("CORR");
  const base = {
    correlationId,
    organizationId: device.organizationId,
    facilityId: device.facilityId,
    occurredAt: receivedAt,
    producer: "api" as const,
  };
  const received = createEnvelope(deps.ids, {
    ...base,
    type: "telemetry.received.v1",
    causationId: null,
    payload: { deviceId, keyId, seq, bodySha256, byteLength: input.byteLength, receivedAt },
  });
  const authenticated = createEnvelope(deps.ids, {
    ...base,
    type: "telemetry.source_authenticated.v1",
    causationId: received.event_id,
    payload: {
      deviceId,
      keyId,
      seq,
      receivedAt,
      assetId: device.assetId,
      ...(device.assetMapping !== undefined && { assetMapping: device.assetMapping }),
      expectedSignals: device.expectedSignals,
      deviceHealth: current.health,
      profile: { profileId: definition.profileId, version: definition.version },
      payload,
    },
  });
  await deps.bus.publish(received);
  await deps.bus.publish(authenticated);
  input.log({
    level: "info",
    message: "source payload accepted",
    fields: { deviceId, seq, profile: definition.profileId, version: definition.version },
  });
  return { status: 202, body: { status: "accepted", correlationId, receivedAt } };
}
