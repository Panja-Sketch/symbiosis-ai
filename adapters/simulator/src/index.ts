import { randomBytes } from "node:crypto";
import { EDGE_PATHS } from "@symbiosis/contracts";
import type { EdgeHeartbeatPayload, EdgeTelemetryPayload } from "@symbiosis/contracts";
import { nowIso, nowSeconds } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import { signEdgeRequest } from "@symbiosis/edge-security";
import { createEdgeV1Adapter } from "@symbiosis/normalization";

export const PACKAGE_NAME = "@symbiosis/adapter-simulator" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export const SIMULATOR_ADAPTER_NAME = "simulator-edge-v1" as const;

/** Normalizes SIMULATOR packets with the same mapping hardware packets use. */
export const simulatorSourceAdapter = createEdgeV1Adapter({
  adapterName: SIMULATOR_ADAPTER_NAME,
  sourceType: "SIMULATOR",
});

export type Readings = Record<string, number | boolean>;

/** Deterministic, healthy-looking readings for ingestion tests. No fault scenarios (S3). */
export function generateNormalReadings(step: number): Readings {
  const wobble = ((step % 5) - 2) * 0.02;
  return {
    temperature_c: Number((4.2 + wobble).toFixed(2)),
    relative_humidity_pct: 55.1,
    vibration_rms_ms2: Number((0.18 + wobble / 10).toFixed(3)),
    current_ma: 312,
    fan_a_load_pct: 100,
    chiller_b_running: false,
  };
}

/** A fully signed request: exact bytes that were hashed and signed are the bytes sent. */
export type SignedEdgeRequest = {
  readonly method: "POST";
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
};

export type SimulatorResponse = { readonly status: number; readonly body: unknown };

export type SimulatorClientOptions = {
  readonly baseUrl: string;
  readonly deviceId: string;
  readonly keyId: string;
  /** Raw 32-byte device key. */
  readonly key: Uint8Array;
  readonly clock: Clock;
  readonly firmwareVersion?: string;
  /** Sequence of the first request. Defaults to the current epoch second (restart-safe). */
  readonly initialSeq?: number;
  readonly nonce?: () => string;
  readonly fetchImpl?: typeof fetch;
};

/**
 * Simulator edge client. It speaks the same wire contract future hardware will: it builds the
 * source payload, serializes the exact bytes, signs them, and sends them to the real edge
 * endpoints. It never calls normalization, quality or the event bus.
 */
export class SimulatorClient {
  private seq: number;
  private step = 0;
  private readonly nonce: () => string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SimulatorClientOptions) {
    this.seq = options.initialSeq ?? nowSeconds(options.clock);
    this.nonce = options.nonce ?? (() => randomBytes(12).toString("base64url"));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Sequence and nonce are shared by telemetry and heartbeat (one counter per device/key). */
  private sign(path: string, payload: unknown): SignedEdgeRequest {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const headers = signEdgeRequest({
      key: this.options.key,
      method: "POST",
      path,
      deviceId: this.options.deviceId,
      keyId: this.options.keyId,
      timestampSeconds: nowSeconds(this.options.clock),
      nonce: this.nonce(),
      seq: this.seq++,
      body,
    });
    return { method: "POST", path, headers, body };
  }

  buildTelemetryRequest(readings?: Readings): SignedEdgeRequest {
    const payload: EdgeTelemetryPayload = {
      device_id: this.options.deviceId,
      firmware_version: this.options.firmwareVersion ?? "sim-0.1.0",
      source: "SIMULATOR",
      batch: [
        {
          observed_at: nowIso(this.options.clock),
          readings: readings ?? generateNormalReadings(this.step++),
        },
      ],
    };
    return this.sign(EDGE_PATHS.telemetry, payload);
  }

  /** Builds a telemetry request from an explicit payload (e.g. multi-sample batches). */
  buildTelemetryRequestFromPayload(payload: EdgeTelemetryPayload): SignedEdgeRequest {
    return this.sign(EDGE_PATHS.telemetry, payload);
  }

  buildHeartbeatRequest(health: EdgeHeartbeatPayload["health"] = "HEALTHY"): SignedEdgeRequest {
    const payload: EdgeHeartbeatPayload = {
      device_id: this.options.deviceId,
      firmware_version: this.options.firmwareVersion ?? "sim-0.1.0",
      sent_at: nowIso(this.options.clock),
      health,
    };
    return this.sign(EDGE_PATHS.heartbeat, payload);
  }

  /** Sends exact bytes and headers; also used to deliberately replay or tamper in tests. */
  async send(request: SignedEdgeRequest): Promise<SimulatorResponse> {
    const response = await this.fetchImpl(`${this.options.baseUrl}${request.path}`, {
      method: request.method,
      headers: { ...request.headers, "Content-Type": "application/json" },
      body: request.body,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    return { status: response.status, body };
  }

  sendTelemetry(readings?: Readings): Promise<SimulatorResponse> {
    return this.send(this.buildTelemetryRequest(readings));
  }

  sendHeartbeat(health?: EdgeHeartbeatPayload["health"]): Promise<SimulatorResponse> {
    return this.send(this.buildHeartbeatRequest(health));
  }
}
