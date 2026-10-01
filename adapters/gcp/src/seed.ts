import { randomBytes } from "node:crypto";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { SYNTHETIC_DEV_DEVICE } from "@symbiosis/device-registry";
import { SYNTHETIC_ACTORS, SYNTHETIC_ORGANIZATIONS } from "@symbiosis/tenancy";
import type { FirestoreAdapterOptions } from "./firestore/common";
import {
  FirestoreActorDirectory,
  FirestoreDeviceRegistry,
  FirestoreIdentityLinks,
  FirestoreOrganizationDirectory,
} from "./firestore/platform";
import { deviceKeySecretId } from "./secrets/device-keys";

/**
 * Explicit, idempotent demo seeding for the cloud project (S9). Synthetic data only; it is NEVER
 * run by a service at startup, only by the operator through `pnpm seed:gcp`. It writes:
 *  - the synthetic organizations, actors and the synthetic device record to Firestore;
 *  - a FRESH random device HMAC key to Secret Manager (the public repository fixture key is not
 *    used in the cloud), readable by the API service account only;
 *  - a small set of Firebase Auth demo users linked to synthetic actors. Passwords are random,
 *    returned to the caller once (the script writes them to an ignored local file) and never logged.
 */
export const DEMO_USERS = [
  { actorId: "USR-FACILITY-MGR-001", email: "facility.manager@symbiosis-demo.example" },
  { actorId: "USR-ORG-ADMIN-001", email: "org.admin@symbiosis-demo.example" },
  { actorId: "USR-RISK-ENGINEER-001", email: "risk.engineer@symbiosis-demo.example" },
  { actorId: "USR-OTHER-ORG-MGR-001", email: "other.org.manager@symbiosis-demo.example" },
] as const;

export type SeedResult = {
  readonly passwords: Readonly<Record<string, string>>;
  readonly createdUsers: readonly string[];
  readonly deviceKeyCreated: boolean;
};

export async function seedGcp(options: {
  readonly firestore: FirestoreAdapterOptions;
  readonly projectId: string;
  readonly apiServiceAccount: string;
  readonly resetPasswords?: boolean;
}): Promise<SeedResult> {
  const { firestore, projectId } = options;
  const actors = new FirestoreActorDirectory(firestore);
  const orgs = new FirestoreOrganizationDirectory(firestore);
  const links = new FirestoreIdentityLinks(firestore);
  const devices = new FirestoreDeviceRegistry(firestore);

  for (const o of SYNTHETIC_ORGANIZATIONS) await orgs.put(o);
  for (const a of SYNTHETIC_ACTORS) await actors.put(a);
  // Overwriting the device record would reset lastSeen/health; only create it when absent.
  if ((await devices.get(SYNTHETIC_DEV_DEVICE.deviceId)) === undefined) {
    await devices.put(SYNTHETIC_DEV_DEVICE);
  }

  const app =
    getApps().find((a) => a.name === `seed-${projectId}`) ??
    initializeApp({ projectId }, `seed-${projectId}`);
  const auth = getAuth(app);
  const passwords: Record<string, string> = {};
  const createdUsers: string[] = [];
  for (const u of DEMO_USERS) {
    const password = randomBytes(18).toString("base64url");
    let uid: string;
    try {
      uid = (await auth.getUserByEmail(u.email)).uid;
      if (options.resetPasswords === true) {
        await auth.updateUser(uid, { password });
        passwords[u.email] = password;
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
      uid = (await auth.createUser({ email: u.email, password, emailVerified: true })).uid;
      passwords[u.email] = password;
      createdUsers.push(u.email);
    }
    await links.link(uid, u.actorId);
  }

  const sm = new SecretManagerServiceClient();
  const secretId = deviceKeySecretId(
    SYNTHETIC_DEV_DEVICE.deviceId,
    SYNTHETIC_DEV_DEVICE.activeKeyId,
  );
  const parent = `projects/${projectId}`;
  let deviceKeyCreated = false;
  try {
    await sm.getSecret({ name: `${parent}/secrets/${secretId}` });
  } catch (e) {
    if ((e as { code?: number }).code !== 5) throw e;
    await sm.createSecret({
      parent,
      secretId,
      secret: {
        replication: { automatic: {} },
        labels: { purpose: "device-hmac-key", synthetic: "true" },
      },
    });
    await sm.addSecretVersion({
      parent: `${parent}/secrets/${secretId}`,
      payload: { data: Buffer.from(randomBytes(32).toString("hex"), "utf8") },
    });
    deviceKeyCreated = true;
  }
  const [policy] = await sm.getIamPolicy({ resource: `${parent}/secrets/${secretId}` });
  const member = `serviceAccount:${options.apiServiceAccount}`;
  const role = "roles/secretmanager.secretAccessor";
  const bindings = policy.bindings ?? [];
  if (!bindings.some((b) => b.role === role && (b.members ?? []).includes(member))) {
    bindings.push({ role, members: [member] });
    await sm.setIamPolicy({
      resource: `${parent}/secrets/${secretId}`,
      policy: { ...policy, bindings },
    });
  }
  return { passwords, createdUsers, deviceKeyCreated };
}
