import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_SIGNALS } from "@symbiosis/contracts";
import type { CanonicalSignal } from "@symbiosis/contracts";
import {
  DeviceProvisioningError,
  Firestore,
  FirestoreDeviceRegistry,
  createProvisionSecrets,
  provisionDevice,
} from "@symbiosis/adapter-gcp";
import { createEdgeDeviceRecord } from "@symbiosis/device-registry";

/**
 * Operator-only provisioning of a signed edge device (a building-automation or IoT gateway, an
 * equipment-API bridge, a simulator vendor profile). Run from your own machine with Application
 * Default Credentials; never from a service or a browser.
 *
 *   GCP_PROJECT_ID=<id> pnpm provision:device \
 *     --confirm-project <id> --device-id DEV-SITE-GATEWAY-001 --asset AST-SIM-FAN-A \
 *     --signals vibration_rms,current [--key-id KEY-SITE-GATEWAY-001] [--profile <source-profile>]
 *     [--org ORG-SIM-001] [--facility FAC-SIM-001]
 *     [--rotate-key]   new key id for an existing device (replay-recovery path)
 *     [--dry-run]      validate arguments only; touches nothing
 *
 * The generated device key is written ONLY to the git-ignored file below and is NEVER printed:
 *   .secrets/devices/<device>.<key>.json
 * It is also stored in Secret Manager (read by the API service account only).
 */
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const value = (name: string, fallback?: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const project = process.env.GCP_PROJECT_ID ?? "";
const deviceId = value("device-id") ?? "";
const keyId = value("key-id") ?? deviceId.replace(/^DEV-/, "KEY-");
const organizationId = value("org", "ORG-SIM-001") as string;
const facilityId = value("facility", "FAC-SIM-001") as string;
const rotate = flag("rotate-key");
const signals = (value("signals", "") ?? "").split(",").filter((s) => s !== "");
for (const s of signals) {
  if (!(CANONICAL_SIGNALS as readonly string[]).includes(s)) {
    throw new Error(`unknown canonical signal: ${s}`);
  }
}

const profile = value("profile");
const record = createEdgeDeviceRecord({
  deviceId,
  keyId,
  organizationId,
  facilityId,
  assetId: value("asset") ?? "",
  expectedSignals: signals as CanonicalSignal[],
  ...(profile !== undefined && { sourceProfile: { profileId: profile } }),
});

if (flag("dry-run")) {
  console.log(
    `dry run ok: would ${rotate ? "rotate the key of" : "register"} ${record.deviceId} ` +
      `(key id ${record.activeKeyId}) in ${organizationId}/${facilityId}. Nothing was changed.`,
  );
  process.exit(0);
}

if (project === "" || value("confirm-project") !== project) {
  throw new Error(
    "refusing to provision: pass --confirm-project <GCP_PROJECT_ID> matching GCP_PROJECT_ID",
  );
}

const db = new Firestore({ projectId: project });
const registry = new FirestoreDeviceRegistry({ db });

try {
  const result = await provisionDevice(
    {
      secrets: createProvisionSecrets(project),
      registry: {
        get: (id) => registry.get(id),
        create: (d) => registry.create(d),
        put: (d) => registry.put(d),
      },
    },
    {
      record,
      apiServiceAccount: `symbiosis-api@${project}.iam.gserviceaccount.com`,
      rotate,
    },
  );

  const dir = join(".secrets", "devices");
  mkdirSync(dir, { recursive: true });
  const keyFile = join(dir, `${result.deviceId}.${result.keyId}.json`);
  writeFileSync(
    keyFile,
    JSON.stringify(
      {
        deviceId: result.deviceId,
        keyId: result.keyId,
        deviceKeyHex: result.keyHex,
        secretManagerSecret: result.secretId,
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // best effort on filesystems without POSIX modes (Windows)
  }

  // Deliberately no key in this output.
  console.log(
    `${result.rotated ? "rotated" : "provisioned"} ${result.deviceId} key ${result.keyId}\n` +
      `  secret: ${result.secretId}\n  written: ${keyFile} (device key; git-ignored)`,
  );
} catch (e) {
  if (e instanceof DeviceProvisioningError) {
    console.error(`provisioning refused (${e.code}): ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
} finally {
  await db.terminate();
}
