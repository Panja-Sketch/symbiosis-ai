import { describe, expect, it } from "vitest";
import { createBenchDeviceRecord } from "@symbiosis/adapter-esp32";
import type { DeviceRecord } from "@symbiosis/device-registry";
import { DeviceProvisioningError, provisionDevice } from "./provision";
import type { ProvisionRegistry, ProvisionSecrets } from "./provision";
import { deviceKeySecretId } from "./secrets/device-keys";

const API_SA = "symbiosis-api@example-project.iam.gserviceaccount.com";

function fakes() {
  const secrets = new Map<string, { labels: Record<string, string>; versions: string[] }>();
  const grants: { secretId: string; member: string }[] = [];
  const devices = new Map<string, DeviceRecord>();
  const calls: string[] = [];
  const failRegistry = { on: false };
  const secretClient: ProvisionSecrets = {
    async secretExists(id) {
      return secrets.has(id);
    },
    async createSecret(id, labels) {
      calls.push(`create:${id}`);
      secrets.set(id, { labels: { ...labels }, versions: [] });
    },
    async addVersion(id, payload) {
      secrets.get(id)?.versions.push(payload);
    },
    async grantAccessor(id, member) {
      grants.push({ secretId: id, member });
    },
    async deleteSecret(id) {
      calls.push(`delete:${id}`);
      secrets.delete(id);
    },
  };
  const registry: ProvisionRegistry = {
    async get(id) {
      return devices.get(id);
    },
    async create(d) {
      if (failRegistry.on) throw new Error("firestore unavailable");
      if (devices.has(d.deviceId)) throw new Error("ALREADY_EXISTS");
      devices.set(d.deviceId, d);
    },
    async put(d) {
      devices.set(d.deviceId, d);
    },
  };
  return { secrets, grants, devices, calls, failRegistry, secretClient, registry };
}

const record = (deviceId = "DEV-PHX-BENCH-001", keyId = "KEY-PHX-001") =>
  createBenchDeviceRecord({
    deviceId,
    keyId,
    organizationId: "ORG-SIM-001",
    facilityId: "FAC-SIM-001",
  });

describe("provisionDevice", () => {
  it("creates a strong key in Secret Manager, grants only the API account and registers the device", async () => {
    const f = fakes();
    const result = await provisionDevice(
      { secrets: f.secretClient, registry: f.registry },
      { record: record(), apiServiceAccount: API_SA },
    );
    expect(result.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secretId).toBe(deviceKeySecretId("DEV-PHX-BENCH-001", "KEY-PHX-001"));
    expect(f.secrets.get(result.secretId)?.versions).toEqual([result.keyHex]);
    expect(f.grants).toEqual([{ secretId: result.secretId, member: `serviceAccount:${API_SA}` }]);
    const stored = f.devices.get("DEV-PHX-BENCH-001");
    expect(stored?.activeKeyId).toBe("KEY-PHX-001");
    expect(stored?.health).toBe("UNKNOWN");
    // the registry record never contains key material
    expect(JSON.stringify(stored)).not.toContain(result.keyHex);
  });

  it("maps vibration/current to the primary asset, zone signals to the zone, Fan B to the backup", async () => {
    const r = record();
    expect(r.assetId).toBe("AST-SIM-FAN-A");
    expect(r.assetMapping?.bySignal?.temperature).toBe("AST-SIM-ZONE-1");
    expect(r.assetMapping?.bySignal?.relative_humidity).toBe("AST-SIM-ZONE-1");
    expect(r.assetMapping?.byField?.chiller_b_running).toBe("AST-SIM-FAN-B");
    expect(r.expectedSignals).not.toContain("load_percent");
  });

  it("generates a different key every time", async () => {
    const a = fakes();
    const b = fakes();
    const ra = await provisionDevice(
      { secrets: a.secretClient, registry: a.registry },
      { record: record(), apiServiceAccount: API_SA },
    );
    const rb = await provisionDevice(
      { secrets: b.secretClient, registry: b.registry },
      { record: record(), apiServiceAccount: API_SA },
    );
    expect(ra.keyHex).not.toBe(rb.keyHex);
  });

  it("refuses a duplicate device id and creates nothing", async () => {
    const f = fakes();
    const deps = { secrets: f.secretClient, registry: f.registry };
    await provisionDevice(deps, { record: record(), apiServiceAccount: API_SA });
    f.calls.length = 0;
    await expect(
      provisionDevice(deps, { record: record(), apiServiceAccount: API_SA }),
    ).rejects.toMatchObject({ code: "DUPLICATE_DEVICE" });
    expect(f.calls).toEqual([]);
  });

  it("never overwrites an existing key secret", async () => {
    const f = fakes();
    f.secrets.set(deviceKeySecretId("DEV-PHX-BENCH-001", "KEY-PHX-001"), {
      labels: {},
      versions: ["existing-key"],
    });
    await expect(
      provisionDevice(
        { secrets: f.secretClient, registry: f.registry },
        { record: record(), apiServiceAccount: API_SA },
      ),
    ).rejects.toMatchObject({ code: "KEY_EXISTS" });
    expect(f.secrets.get(deviceKeySecretId("DEV-PHX-BENCH-001", "KEY-PHX-001"))?.versions).toEqual([
      "existing-key",
    ]);
  });

  it("rolls back the secret it created when registration fails, so a retry is possible", async () => {
    const f = fakes();
    f.failRegistry.on = true;
    await expect(
      provisionDevice(
        { secrets: f.secretClient, registry: f.registry },
        { record: record(), apiServiceAccount: API_SA },
      ),
    ).rejects.toThrow("firestore unavailable");
    expect(f.secrets.size).toBe(0);
    expect(f.calls.some((c) => c.startsWith("delete:"))).toBe(true);
  });

  it("rotation needs an existing device and a NEW key id; the old key stops being the active one", async () => {
    const f = fakes();
    const deps = { secrets: f.secretClient, registry: f.registry };
    await expect(
      provisionDevice(deps, {
        record: record("DEV-PHX-BENCH-001", "KEY-PHX-002"),
        apiServiceAccount: API_SA,
        rotate: true,
      }),
    ).rejects.toMatchObject({ code: "UNKNOWN_DEVICE" });
    await provisionDevice(deps, { record: record(), apiServiceAccount: API_SA });
    await expect(
      provisionDevice(deps, { record: record(), apiServiceAccount: API_SA, rotate: true }),
    ).rejects.toMatchObject({ code: "SAME_KEY_ID" });
    const rotated = await provisionDevice(deps, {
      record: record("DEV-PHX-BENCH-001", "KEY-PHX-002"),
      apiServiceAccount: API_SA,
      rotate: true,
    });
    expect(rotated.rotated).toBe(true);
    expect(f.devices.get("DEV-PHX-BENCH-001")?.activeKeyId).toBe("KEY-PHX-002");
  });

  it("rejects malformed ids before touching the cloud", () => {
    expect(() =>
      createBenchDeviceRecord({
        deviceId: "dev lower",
        keyId: "KEY-1",
        organizationId: "O",
        facilityId: "F",
      }),
    ).toThrow();
    expect(() =>
      createBenchDeviceRecord({
        deviceId: "DEV-1",
        keyId: "key-1",
        organizationId: "O",
        facilityId: "F",
      }),
    ).toThrow();
  });

  it("errors never carry the key", async () => {
    const f = fakes();
    f.failRegistry.on = true;
    let message = "";
    let key = "";
    try {
      await provisionDevice(
        {
          secrets: f.secretClient,
          registry: f.registry,
          newKey: () => {
            const k = new Uint8Array(32).fill(0xab);
            key = Buffer.from(k).toString("hex");
            return k;
          },
        },
        { record: record(), apiServiceAccount: API_SA },
      );
    } catch (e) {
      message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    expect(message).not.toContain(key);
    expect(new DeviceProvisioningError("KEY_EXISTS", "x").name).toBe("DeviceProvisioningError");
  });
});
