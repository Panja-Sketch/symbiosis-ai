import { randomBytes } from "node:crypto";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import type { DeviceRecord } from "@symbiosis/device-registry";
import { deviceKeySecretId } from "./secrets/device-keys";

/**
 * Operator-only physical-device provisioning (S10). Never run by a service and never reachable
 * from a browser. It:
 *  1. generates a cryptographically strong 32-byte device key;
 *  2. stores it in Secret Manager under the S9 naming scheme (never overwriting an existing key),
 *     readable by the API service account only;
 *  3. creates the device record in the registry (atomic create: a duplicate device id fails);
 *  4. hands the key back to the CALLER in memory so it can be written to a git-ignored local file.
 * The key is never logged by this module and never stored outside Secret Manager and the caller's
 * local file.
 */
export interface ProvisionSecrets {
  secretExists(secretId: string): Promise<boolean>;
  createSecret(secretId: string, labels: Readonly<Record<string, string>>): Promise<void>;
  addVersion(secretId: string, payload: string): Promise<void>;
  /** Grants secretmanager.secretAccessor on this one secret to `member`. Idempotent. */
  grantAccessor(secretId: string, member: string): Promise<void>;
  /** Used only to undo a secret THIS run created if a later step fails. */
  deleteSecret(secretId: string): Promise<void>;
}

export interface ProvisionRegistry {
  get(deviceId: string): Promise<DeviceRecord | undefined>;
  /** Must fail if the device id already exists. */
  create(device: DeviceRecord): Promise<void>;
  /** Replaces an existing record (key rotation only). */
  put(device: DeviceRecord): Promise<void>;
}

export type ProvisionRequest = {
  readonly record: DeviceRecord;
  /** The API service account that must be able to read the new key (and nobody else). */
  readonly apiServiceAccount: string;
  /** Rotation: the device must already exist and `record.activeKeyId` must be a NEW key id. */
  readonly rotate?: boolean;
};

export type ProvisionResult = {
  readonly deviceId: string;
  readonly keyId: string;
  readonly secretId: string;
  /** 64 hex characters. Returned in memory only; the caller must not log it. */
  readonly keyHex: string;
  readonly rotated: boolean;
};

export class DeviceProvisioningError extends Error {
  constructor(
    readonly code:
      "DUPLICATE_DEVICE" | "UNKNOWN_DEVICE" | "SAME_KEY_ID" | "KEY_EXISTS" | "INVALID_RECORD",
    message: string,
  ) {
    super(message);
    this.name = "DeviceProvisioningError";
  }
}

export async function provisionDevice(
  deps: {
    readonly secrets: ProvisionSecrets;
    readonly registry: ProvisionRegistry;
    readonly newKey?: () => Uint8Array;
  },
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const { record } = request;
  if (record.status !== "ACTIVE" || record.health !== "UNKNOWN") {
    throw new DeviceProvisioningError(
      "INVALID_RECORD",
      "a new device record must be ACTIVE with health UNKNOWN",
    );
  }
  const existing = await deps.registry.get(record.deviceId);
  const rotate = request.rotate === true;
  if (!rotate && existing !== undefined) {
    throw new DeviceProvisioningError(
      "DUPLICATE_DEVICE",
      `device ${record.deviceId} is already registered; use --rotate-key with a new key id`,
    );
  }
  if (rotate) {
    if (existing === undefined) {
      throw new DeviceProvisioningError("UNKNOWN_DEVICE", `device ${record.deviceId} not found`);
    }
    if (existing.activeKeyId === record.activeKeyId) {
      throw new DeviceProvisioningError("SAME_KEY_ID", "rotation needs a NEW key id");
    }
    if (
      existing.organizationId !== record.organizationId ||
      existing.facilityId !== record.facilityId
    ) {
      throw new DeviceProvisioningError(
        "INVALID_RECORD",
        "rotation may not move a device to another organization or facility",
      );
    }
  }

  const secretId = deviceKeySecretId(record.deviceId, record.activeKeyId);
  if (await deps.secrets.secretExists(secretId)) {
    throw new DeviceProvisioningError(
      "KEY_EXISTS",
      `secret ${secretId} already exists; a device key is never overwritten`,
    );
  }

  const key = (deps.newKey ?? (() => randomBytes(32)))();
  if (key.length !== 32) throw new Error("device key must be 32 bytes");
  const keyHex = Buffer.from(key).toString("hex");

  await deps.secrets.createSecret(secretId, { purpose: "device-hmac-key", hardware: "true" });
  try {
    await deps.secrets.addVersion(secretId, keyHex);
    await deps.secrets.grantAccessor(secretId, `serviceAccount:${request.apiServiceAccount}`);
    if (rotate && existing !== undefined) {
      // Same device, same mapping; only the active key id changes (the old key stops working).
      await deps.registry.put({ ...existing, activeKeyId: record.activeKeyId });
    } else {
      await deps.registry.create(record);
    }
  } catch (e) {
    // Roll back the secret this run created so a retry is possible; never leave an orphan key.
    await deps.secrets.deleteSecret(secretId).catch(() => undefined);
    throw e;
  }
  return {
    deviceId: record.deviceId,
    keyId: record.activeKeyId,
    secretId,
    keyHex,
    rotated: rotate,
  };
}

/** Real Secret Manager access for the provisioning script. */
export function createProvisionSecrets(projectId: string): ProvisionSecrets {
  const sm = new SecretManagerServiceClient();
  const parent = `projects/${projectId}`;
  const name = (id: string) => `${parent}/secrets/${id}`;
  return {
    async secretExists(id) {
      try {
        await sm.getSecret({ name: name(id) });
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === 5) return false;
        throw e;
      }
    },
    async createSecret(id, labels) {
      await sm.createSecret({
        parent,
        secretId: id,
        secret: { replication: { automatic: {} }, labels: { ...labels } },
      });
    },
    async addVersion(id, payload) {
      await sm.addSecretVersion({
        parent: name(id),
        payload: { data: Buffer.from(payload, "utf8") },
      });
    },
    async grantAccessor(id, member) {
      const role = "roles/secretmanager.secretAccessor";
      const [policy] = await sm.getIamPolicy({ resource: name(id) });
      const bindings = policy.bindings ?? [];
      if (!bindings.some((b) => b.role === role && (b.members ?? []).includes(member))) {
        bindings.push({ role, members: [member] });
        await sm.setIamPolicy({ resource: name(id), policy: { ...policy, bindings } });
      }
    },
    async deleteSecret(id) {
      await sm.deleteSecret({ name: name(id) });
    },
  };
}
