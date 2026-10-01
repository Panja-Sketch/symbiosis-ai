import type { AssetMapping, CanonicalSignal, DeviceHealth } from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/device-registry" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export const DEVICE_STATUSES = ["ACTIVE", "DISABLED"] as const;
export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

/** Device identity and trust metadata (spec section 10). Holds no key material. */
export type DeviceRecord = {
  readonly deviceId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  /** Default (primary) asset; readings not covered by `assetMapping` belong to it. */
  readonly assetId: string;
  /** Optional per-field / per-signal placement onto other logical assets or zones. */
  readonly assetMapping?: AssetMapping;
  readonly status: DeviceStatus;
  /** The only key version currently accepted for this device. */
  readonly activeKeyId: string;
  readonly expectedSignals: readonly CanonicalSignal[];
  readonly capabilities: readonly string[];
  readonly firmwareVersion?: string;
  readonly lastSeenAt?: string;
  /** UNKNOWN until a heartbeat reports otherwise; never treated as healthy. */
  readonly health: DeviceHealth;
};

export type DeviceSeen = {
  readonly seenAt: string;
  readonly firmwareVersion?: string;
  readonly health?: Exclude<DeviceHealth, "UNKNOWN">;
};

export interface DeviceRegistry {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  recordSeen(deviceId: string, seen: DeviceSeen): Promise<void>;
}

/**
 * Key material is kept apart from the registry so a Secret Manager adapter can replace the
 * in-memory store later. Returns the raw 32-byte key, or undefined if unknown.
 */
export interface DeviceKeyStore {
  getKey(deviceId: string, keyId: string): Promise<Uint8Array | undefined>;
}

export class InMemoryDeviceRegistry implements DeviceRegistry {
  private readonly records = new Map<string, DeviceRecord>();

  constructor(initial: readonly DeviceRecord[] = []) {
    for (const r of initial) this.records.set(r.deviceId, r);
  }

  async get(deviceId: string): Promise<DeviceRecord | undefined> {
    return this.records.get(deviceId);
  }

  async recordSeen(deviceId: string, seen: DeviceSeen): Promise<void> {
    const current = this.records.get(deviceId);
    if (current === undefined) return;
    this.records.set(deviceId, {
      ...current,
      lastSeenAt: seen.seenAt,
      ...(seen.firmwareVersion !== undefined && { firmwareVersion: seen.firmwareVersion }),
      ...(seen.health !== undefined && { health: seen.health }),
    });
  }
}

export class InMemoryDeviceKeyStore implements DeviceKeyStore {
  private readonly keys = new Map<string, Uint8Array>();

  constructor(entries: readonly { deviceId: string; keyId: string; key: Uint8Array }[] = []) {
    for (const e of entries) this.keys.set(`${e.deviceId}|${e.keyId}`, e.key);
  }

  async getKey(deviceId: string, keyId: string): Promise<Uint8Array | undefined> {
    return this.keys.get(`${deviceId}|${keyId}`);
  }
}

const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** Parses a device key given as 64 hex characters into its raw 32 bytes. */
export function deviceKeyFromHex(hex: string): Uint8Array {
  if (!HEX_KEY.test(hex)) throw new Error("device key must be 64 hex characters (32 bytes)");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * SYNTHETIC DEVELOPMENT FIXTURE ONLY. This key is public, obviously fake and grants access
 * to nothing real. Real device keys never enter Git (production: Secret Manager).
 */
export const SYNTHETIC_DEV_KEY_HEX = "0123456789abcdef".repeat(4);

export const SYNTHETIC_DEV_DEVICE: DeviceRecord = {
  deviceId: "DEV-SIM-001",
  organizationId: "ORG-SIM-001",
  facilityId: "FAC-SIM-001",
  // Primary cooling/fan asset. Zone and backup readings map to other logical assets.
  assetId: "AST-SIM-FAN-A",
  assetMapping: {
    bySignal: {
      temperature: "AST-SIM-ZONE-1",
      relative_humidity: "AST-SIM-ZONE-1",
      outdoor_temperature: "AST-SIM-OUTDOOR",
    },
    byField: { chiller_b_running: "AST-SIM-FAN-B" },
  },
  status: "ACTIVE",
  activeKeyId: "KEY-SIM-001",
  expectedSignals: [
    "temperature",
    "relative_humidity",
    "vibration_rms",
    "current",
    "load_percent",
    "equipment_running",
    "outdoor_temperature",
  ],
  capabilities: ["telemetry", "heartbeat"],
  health: "UNKNOWN",
};

export function createSyntheticDevRegistry(): {
  registry: InMemoryDeviceRegistry;
  keys: InMemoryDeviceKeyStore;
} {
  return {
    registry: new InMemoryDeviceRegistry([SYNTHETIC_DEV_DEVICE]),
    keys: new InMemoryDeviceKeyStore([
      {
        deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
        keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
        key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
      },
    ]),
  };
}
