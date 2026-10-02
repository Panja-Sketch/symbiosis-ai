import { EDGE_PATHS } from "@symbiosis/contracts";
import type { EdgeHeartbeatPayload } from "@symbiosis/contracts";
import { nowIso, nowSeconds } from "@symbiosis/clock";
import type { Clock } from "@symbiosis/clock";
import type { DeviceKeyStore, DeviceRegistry } from "@symbiosis/device-registry";
import { signEdgeRequest } from "@symbiosis/edge-security";
import type { IdGenerator } from "@symbiosis/event-bus";
import type { TenantDocumentStore } from "@symbiosis/repositories";
import { SAMPLE_INTERVAL_MS, SimulationError, gridFloor } from "./control";
import type { Scope, SimulationSession } from "./control";
import type { FacilityDevice, FacilityModel } from "./facility";
import { isSimulationScope } from "./facility";
import { buildVendorPayload } from "./payloads";
import { valuesAt } from "./state";
import type { StateRevision } from "./state";

/**
 * Simulation engine (S10, D-091): turns the simulated physical world into SIGNED VENDOR PAYLOADS and
 * sends them to the platform's edge boundary exactly as a customer's gateway would. It never calls
 * normalization, quality, detection, cases, verification or evidence: it only produces source data.
 *
 * A pulse sends every 5-second instant that has not been sent yet (at most the last minute, so a
 * long pause leaves an honest gap rather than back-filled data). The world at each instant comes
 * from the recorded state history, so a catch-up never invents a value that was not in force then.
 */
export type EdgeSubmitRequest = {
  readonly method: "POST";
  readonly target: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
};
export type EdgeSubmit = (request: EdgeSubmitRequest) => Promise<{ status: number; body: unknown }>;

export type PulseResult = {
  readonly status: "OK" | "STOPPED" | "BUSY";
  readonly instants: number;
  readonly sent: number;
  readonly rejected: readonly { deviceId: string; status: number; code: string }[];
  readonly lastEmittedAt?: string;
};

export type EngineDeps = {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: TenantDocumentStore;
  readonly facility: FacilityModel;
  readonly registry: DeviceRegistry;
  readonly keys: DeviceKeyStore;
  readonly submit: EdgeSubmit;
  /** Called once per pulse after the devices were sent (live or simulated weather ingestion). */
  readonly onPulse?: (ctx: { readonly session: SimulationSession }) => Promise<void>;
  /** At most this many past instants are sent in one pulse. */
  readonly maxCatchUpInstants?: number;
};

const CONTROL = "simulationControl" as const;
const LEASE_MS = 25_000;

export function createSimulationEngine(deps: EngineDeps) {
  const { facility, store } = deps;
  const org = facility.organizationId;
  const fac = facility.facilityId;
  const maxCatchUp = deps.maxCatchUpInstants ?? 12;

  async function history(sessionId: string): Promise<readonly StateRevision[]> {
    return store.list<StateRevision>("simulationStates", org, {
      where: { sessionId },
      limit: 1000,
    });
  }

  const body = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));

  async function send(
    device: FacilityDevice,
    target: string,
    payload: unknown,
    seq: number,
  ): Promise<{ status: number; body: unknown } | { status: 0; body: { code: string } }> {
    const record = await deps.registry.get(device.deviceId);
    if (record === undefined) return { status: 0, body: { code: "DEVICE_NOT_REGISTERED" } };
    const key = await deps.keys.getKey(device.deviceId, record.activeKeyId);
    if (key === undefined) return { status: 0, body: { code: "NO_DEVICE_KEY" } };
    const raw = body(payload);
    const headers = signEdgeRequest({
      key,
      method: "POST",
      path: target,
      deviceId: device.deviceId,
      keyId: record.activeKeyId,
      timestampSeconds: nowSeconds(deps.clock),
      nonce: `${deps.ids.next("N")}${seq}`
        .replace(/[^A-Za-z0-9_-]/g, "")
        .padEnd(16, "0")
        .slice(0, 64),
      seq,
      body: raw,
    });
    // The edge handler takes lower-case header names (an HTTP server lower-cases them).
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return deps.submit({ method: "POST", target, headers: lower, rawBody: raw });
  }

  return {
    /**
     * One emission step. `expectedGeneration` is the generation the caller loaded; after a reset it
     * no longer matches and the pulse is refused, so an old tab can never restart a cleared world.
     */
    async pulse(scope: Scope, expectedGeneration: number | undefined): Promise<PulseResult> {
      if (!isSimulationScope(facility, scope.organizationId, scope.facilityId)) {
        throw new SimulationError("OUT_OF_SCOPE", "not a simulation facility");
      }
      const holder = deps.ids.next("PULSE");
      const now = deps.clock.nowMs();
      const flow = { outcome: "STOPPED" as "OK" | "STOPPED" | "BUSY" | "RESET" };
      let base = 0;
      let fromMs = 0;
      let toMs = 0;
      const claimed = await store.update<SimulationSession>(CONTROL, org, fac, (cur) => {
        if (cur === undefined || cur.status !== "RUNNING") {
          flow.outcome = "STOPPED";
          return undefined;
        }
        if (expectedGeneration !== undefined && cur.generation !== expectedGeneration) {
          flow.outcome = "RESET";
          return undefined;
        }
        if (cur.lease !== undefined && cur.lease.untilMs > now) {
          flow.outcome = "BUSY";
          return undefined;
        }
        flow.outcome = "OK";
        const to = gridFloor(now);
        const earliest = to - (maxCatchUp - 1) * SAMPLE_INTERVAL_MS;
        fromMs = Math.max(
          cur.lastEmittedMs + SAMPLE_INTERVAL_MS,
          earliest,
          gridFloor(Date.parse(cur.startedAt)),
        );
        toMs = to;
        const instants = fromMs <= toMs ? Math.floor((toMs - fromMs) / SAMPLE_INTERVAL_MS) + 1 : 0;
        // Reserve a block of request sequence numbers: heartbeats and samples for every device.
        base = Math.max(cur.seqCursor, now);
        const reserve = (instants + 1) * facility.devices.length + 8;
        return {
          doc: {
            ...cur,
            lease: { holder, untilMs: now + LEASE_MS },
            seqCursor: base + reserve,
            lastPulseAt: new Date(now).toISOString(),
            pulses: cur.pulses + 1,
          },
        };
      });
      if (flow.outcome === "RESET") {
        throw new SimulationError("SESSION_RESET", "the simulation was reset; reload the page");
      }
      if (flow.outcome !== "OK" || claimed === undefined) {
        return {
          status: flow.outcome === "BUSY" ? "BUSY" : "STOPPED",
          instants: 0,
          sent: 0,
          rejected: [],
        };
      }

      const rejected: { deviceId: string; status: number; code: string }[] = [];
      let sent = 0;
      let lastEmitted = claimed.lastEmittedMs;
      let seq = base;
      let instants = 0;
      try {
        const states = await history(claimed.sessionId);
        // A heartbeat per device first: health comes from the simulated sensor condition.
        const atNow = valuesAt(states, now);
        for (const device of facility.devices) {
          // A heartbeat is sent even while samples are missing: health and silence are different facts.
          const cond = atNow.sensors[device.group];
          const hb: EdgeHeartbeatPayload = {
            device_id: device.deviceId,
            firmware_version: "sim-gateway-1.0",
            sent_at: nowIso(deps.clock),
            health: cond.health,
          };
          const r = await send(device, EDGE_PATHS.heartbeat, hb, seq++);
          if (r.status !== 200)
            rejected.push({ deviceId: device.deviceId, status: r.status, code: codeOf(r.body) });
        }
        for (let t = fromMs; t <= toMs; t += SAMPLE_INTERVAL_MS) {
          instants += 1;
          const values = valuesAt(states, t);
          for (const device of facility.devices) {
            if (values.sensors[device.group].dropout) continue;
            const built = buildVendorPayload(device.profileId, device.group, {
              seed: claimed.sessionId,
              values,
              instantMs: t,
            });
            if (built === undefined) continue;
            const r = await send(device, EDGE_PATHS.source, built.payload, seq++);
            if (r.status === 202) sent += 1;
            else
              rejected.push({ deviceId: device.deviceId, status: r.status, code: codeOf(r.body) });
          }
          lastEmitted = t;
        }
      } finally {
        await store.update<SimulationSession>(CONTROL, org, fac, (cur) =>
          cur === undefined || cur.lease?.holder !== holder
            ? undefined
            : {
                doc: ((): SimulationSession => {
                  const rest: { -readonly [K in keyof SimulationSession]: SimulationSession[K] } = {
                    ...cur,
                  };
                  delete rest.lease;
                  return {
                    ...rest,
                    lastEmittedMs: Math.max(cur.lastEmittedMs, lastEmitted),
                    emitted: cur.emitted + sent,
                    rejected: cur.rejected + rejected.length,
                  };
                })(),
              },
        );
      }
      await deps.onPulse?.({ session: claimed });
      return {
        status: "OK",
        instants,
        sent,
        rejected,
        ...(lastEmitted > 0 && { lastEmittedAt: new Date(lastEmitted).toISOString() }),
      };
    },
  };
}

const codeOf = (b: unknown): string => {
  const e = (b as { error?: { code?: unknown }; code?: unknown } | null) ?? {};
  return typeof e.error?.code === "string"
    ? e.error.code
    : typeof e.code === "string"
      ? e.code
      : "UNKNOWN";
};

export type SimulationEngine = ReturnType<typeof createSimulationEngine>;
