import { GoogleAuth } from "google-auth-library";
import type { Firestore } from "@google-cloud/firestore";
import type { SecretAccess } from "./secrets/device-keys";
import { COLLECTIONS as C } from "./firestore/common";

/**
 * Google Cloud adapters for the S10 simulation and notification features. Everything here is
 * reachable only from the composition roots; no domain package imports it.
 */

// ---- SMTP credentials (Secret Manager) --------------------------------------------------------------

export class EmailNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailNotConfigured";
  }
}

/**
 * Reads the demo SMTP credentials from ONE Secret Manager secret whose payload is JSON
 * `{"username": "...", "password": "..."}` (a dedicated sender mailbox and its app password). The
 * operator adds the secret version directly in Secret Manager: the value is never typed into chat,
 * stored in Firestore, put in an environment file, committed or printed. This reader caches it for a
 * few minutes in process memory, never logs it, and reports "not configured" (a permanent failure)
 * when the secret or its payload is missing or malformed.
 */
export function createSmtpCredentialsReader(
  secrets: SecretAccess,
  secretId: string,
  ttlMs = 300_000,
  now: () => number = () => Date.now(),
): () => Promise<{ username: string; password: string }> {
  let cached: { at: number; value: { username: string; password: string } } | undefined;
  return async () => {
    if (cached !== undefined && now() - cached.at < ttlMs) return cached.value;
    const raw = await secrets.accessLatest(secretId);
    if (raw === undefined) throw new EmailNotConfiguredError("the SMTP credentials secret has no version");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new EmailNotConfiguredError("the SMTP credentials secret is not valid JSON");
    }
    const o = parsed as { username?: unknown; password?: unknown } | null;
    if (
      o === null ||
      typeof o.username !== "string" ||
      typeof o.password !== "string" ||
      o.username === "" ||
      o.password === ""
    ) {
      throw new EmailNotConfiguredError("the SMTP credentials secret needs a username and a password");
    }
    cached = { at: now(), value: { username: o.username, password: o.password } };
    return cached.value;
  };
}

// ---- Weather API authentication ---------------------------------------------------------------------

/**
 * Headers for the Google Maps Platform Weather API. `adc`: the runtime service identity's OAuth token
 * (preferred; nothing to store). `api-key`: a dedicated key restricted to the Weather API, read from
 * Secret Manager and sent in the `X-Goog-Api-Key` header (never in a URL). Neither is ever logged.
 */
export function createWeatherAuthHeaders(options: {
  readonly mode: "adc" | "api-key";
  readonly projectId: string;
  readonly secrets?: SecretAccess;
  readonly apiKeySecretId?: string;
}): () => Promise<Record<string, string>> {
  if (options.mode === "api-key") {
    const { secrets, apiKeySecretId } = options;
    if (secrets === undefined || apiKeySecretId === undefined) {
      throw new Error("api-key weather authentication needs a secret id");
    }
    let key: { at: number; value: string } | undefined;
    return async () => {
      if (key === undefined || Date.now() - key.at > 300_000) {
        const v = await secrets.accessLatest(apiKeySecretId);
        if (v === undefined || v.trim() === "") throw new Error("the weather API key secret has no version");
        key = { at: Date.now(), value: v.trim() };
      }
      return { "X-Goog-Api-Key": key.value };
    };
  }
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    const token = await auth.getAccessToken();
    if (typeof token !== "string" || token === "") throw new Error("no ADC access token");
    return { Authorization: `Bearer ${token}`, "X-Goog-User-Project": options.projectId };
  };
}

// ---- "run the scheduler checks now" -----------------------------------------------------------------

/**
 * Asks the private worker to run one scheduler pass, authenticating as the API's own service
 * identity with a Google-signed ID token for the worker's URL. The worker still verifies it.
 */
export function createWorkerTickInvoker(workerUrl: string): () => Promise<void> {
  const auth = new GoogleAuth();
  const base = workerUrl.replace(/\/+$/, "");
  return async () => {
    const client = await auth.getIdTokenClient(base);
    const res = await client.request({ url: `${base}/tick`, method: "POST", data: "{}", timeout: 60_000 });
    if (res.status < 200 || res.status >= 300) throw new Error(`worker tick answered ${res.status}`);
  };
}

// ---- simulation reset: remove one facility's domain records -------------------------------------------

const DOMAIN_COLLECTIONS = [
  C.observations,
  C.baselines,
  C.baselineSnapshots,
  C.baselineAudit,
  C.detectionStates,
  C.cases,
  C.riskEvents,
  C.alerts,
  C.actions,
  C.verifications,
  C.interventions,
  C.evidencePackages,
  C.evidencePackageByVerification,
  C.sharingAgreements,
  C.sharedEvidence,
] as const;

type Rec = {
  organizationId?: string;
  facilityId?: string;
  caseId?: string;
  facilityIds?: string[];
  key?: { facilityId?: string };
};

/**
 * Deletes the domain records of ONE facility of ONE organization (the simulation facility). A record
 * belongs to the facility when it names it, or names one of its cases. Other facilities of the
 * organization, other organizations, the audit log, registry, policies and identities are never
 * touched. Evidence objects in Cloud Storage are immutable and are left in place (unreferenced).
 */
export function createFirestoreFacilityPurge(options: {
  readonly db: Firestore;
  readonly collectionPrefix?: string;
}): (scope: { organizationId: string; facilityId: string }) => Promise<Record<string, number>> {
  const prefix = options.collectionPrefix ?? "";
  return async ({ organizationId, facilityId }) => {
    const removed: Record<string, number> = {};
    const col = (name: string) => options.db.collection(`${prefix}${name}`);
    const caseIds = new Set<string>();
    {
      const snap = await col(C.cases).where("organizationId", "==", organizationId).get();
      for (const d of snap.docs) {
        const j = JSON.parse(String(d.get("json"))) as Rec;
        if (j.facilityId === facilityId && typeof j.caseId === "string") caseIds.add(j.caseId);
      }
    }
    for (const name of DOMAIN_COLLECTIONS) {
      const snap = await col(name).where("organizationId", "==", organizationId).get();
      const doomed = snap.docs.filter((d) => {
        const raw = d.get("json");
        const j = (typeof raw === "string" ? JSON.parse(raw) : {}) as Rec;
        const caseId = typeof j.caseId === "string" ? j.caseId : (d.get("caseId") as string | undefined);
        return (
          j.facilityId === facilityId ||
          j.key?.facilityId === facilityId ||
          (j.facilityIds?.includes(facilityId) ?? false) ||
          (caseId !== undefined && caseIds.has(caseId))
        );
      });
      for (let i = 0; i < doomed.length; i += 400) {
        const batch = options.db.batch();
        for (const d of doomed.slice(i, i + 400)) batch.delete(d.ref);
        await batch.commit();
      }
      removed[name] = doomed.length;
    }
    return removed;
  };
}
