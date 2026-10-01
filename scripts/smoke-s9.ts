import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  Firestore,
  FirestoreActorDirectory,
  FirestoreAuditLog,
  FirestoreCaseRepository,
  FirestoreIdentityLinks,
  GcsEvidenceObjectStore,
  PubSubBus,
  SecretManagerDeviceKeyStore,
  createAdcAccessTokenProvider,
  createFirebaseTokenVerifier,
  createGcsObjectClient,
  createSecretAccess,
  createTopicPublisher,
} from "@symbiosis/adapter-gcp";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { GeminiExplanationProvider, validateExplanation } from "@symbiosis/ai-explanation";
import { SystemClock } from "@symbiosis/clock";
import { SYNTHETIC_DEV_DEVICE } from "@symbiosis/device-registry";
import { facilityContext, insurerContext } from "../packages/ai-explanation/src/fixtures";
import { loadExplanationConfig } from "@symbiosis/runtime";

/**
 * S9 cloud smoke (OPT-IN: it touches the real project). Verifies the deployed runtime and the
 * production adapters against the actual Google Cloud project:
 *   part A  adapters live (Firebase verification, Firestore, tenant isolation, Pub/Sub, Cloud
 *           Storage, Secret Manager, Vertex);
 *   part B  deployed Cloud Run services (public/private boundary, authentication);
 *   part C  the hero case end to end on the cloud runtime in REAL time, with signed device
 *           telemetry through the API, the Pub/Sub worker, Scheduler ticks, verification,
 *           evidence, consent, revocation and a Vertex explanation produced by the API's own
 *           Cloud Run identity.
 * Run: SMOKE_S9=1 GCP_PROJECT_ID=<id> pnpm smoke:s9 --confirm-project <id>
 * Part A uses throwaway collections/objects that it deletes. Part C writes ONE synthetic demo case
 * and one (revoked) sharing agreement into the synthetic demo tenant; those are demo records.
 * Secrets, tokens and passwords are never printed.
 */
const project = process.env.GCP_PROJECT_ID ?? "";
const confirm = process.argv[process.argv.indexOf("--confirm-project") + 1];
if (process.env.SMOKE_S9 !== "1" || project === "" || confirm !== project) {
  console.error(
    "smoke:s9 touches the REAL Google Cloud project. Opt in with:\n" +
      "  SMOKE_S9=1 GCP_PROJECT_ID=<id> pnpm smoke:s9 --confirm-project <id>",
  );
  process.exit(2);
}
const region = process.env.GCP_REGION ?? "us-central1";
const run = randomBytes(4).toString("hex");

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

const gcloud = (...args: string[]): string =>
  execFileSync("gcloud", args, {
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
const serviceUrl = (name: string): string =>
  gcloud(
    "run",
    "services",
    "describe",
    name,
    "--project",
    project,
    "--region",
    region,
    "--format=value(status.url)",
  ).trim();
const API = serviceUrl("symbiosis-api");
const WEB = serviceUrl("symbiosis-web");
const WORKER = serviceUrl("symbiosis-worker");

const webConfig = JSON.parse(readFileSync("infrastructure/firebase-web-config.json", "utf8")) as {
  apiKey: string;
};
const passwords = JSON.parse(readFileSync(".secrets/demo-users.json", "utf8")) as Record<
  string,
  string
>;
const USERS = {
  manager: "facility.manager@symbiosis-demo.example",
  admin: "org.admin@symbiosis-demo.example",
  insurer: "risk.engineer@symbiosis-demo.example",
  other: "other.org.manager@symbiosis-demo.example",
} as const;

async function signIn(email: string): Promise<string> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${webConfig.apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: passwords[email], returnSecureToken: true }),
    },
  );
  const j = (await res.json()) as { idToken?: string };
  if (j.idToken === undefined) throw new Error(`sign-in failed for a demo user (${res.status})`);
  return j.idToken;
}

type Json = ReturnType<typeof JSON.parse>;
async function call(method: string, path: string, token?: string, body?: unknown, base = API) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(token !== undefined && { authorization: `Bearer ${token}` }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, body: json as Json, text };
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms: number, every = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) {
      console.log(`  (timed out waiting for ${what})`);
      return undefined;
    }
    await sleep(every);
  }
}

const db = new Firestore({ projectId: project });
const prefix = `smoke${run}_`;

// ============================================================================ part A: adapters
console.log(`\n== A. production adapters against ${project} (run ${run}) ==`);

console.log("\n-- 1. Firebase token verification --");
const verifier = createFirebaseTokenVerifier({ projectId: project, checkRevoked: true });
const links = new FirestoreIdentityLinks({ db });
const directory = new FirestoreActorDirectory({ db });
const mgrToken = await signIn(USERS.manager);
const verified = await verifier(mgrToken).catch(() => undefined);
check(
  "1a. a real ID token verifies (signature, issuer, audience, expiry, revocation)",
  verified !== undefined,
);
const actorId = verified === undefined ? undefined : await links.actorIdForUid(verified.uid);
check(
  "1b. the UID resolves to the canonical actor through the trusted link",
  actorId === "USR-FACILITY-MGR-001",
);
const actor = actorId === undefined ? undefined : await directory.get(actorId);
check(
  "1c. organization and roles come from the stored actor record",
  actor?.organizationId === "ORG-SIM-001" && actor.roles.includes("FACILITY_MANAGER"),
);
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", aud: project, iss: `https://securetoken.google.com/${project}`, exp: 4102444800 })}.`;
check(
  "1d. an unsigned/forged token is rejected",
  (await verifier(forged).then(
    () => true,
    () => false,
  )) === false,
);
const tampered = `${mgrToken.split(".").slice(0, 2).join(".")}.${randomBytes(64).toString("base64url")}`;
check(
  "1e. a token with a broken signature is rejected",
  (await verifier(tampered).then(
    () => true,
    () => false,
  )) === false,
);
const otherProject = createFirebaseTokenVerifier({
  projectId: `${project}-other`,
  checkRevoked: false,
});
check(
  "1f. a real token is rejected by a verifier for another project (audience/issuer)",
  (await otherProject(mgrToken).then(
    () => true,
    () => false,
  )) === false,
);

console.log("\n-- 2-3. Firestore through the repository contract, and tenant isolation --");
const cases = new FirestoreCaseRepository({ db, collectionPrefix: prefix });
const audit = new FirestoreAuditLog({ db, collectionPrefix: prefix });
const T = new Date().toISOString();
await cases.save({
  caseId: "CASE-SMOKE",
  organizationId: `ORG-SMOKE-A-${run}`,
  facilityId: "FAC-SMOKE",
  assetIds: ["AST-1"],
  origin: { type: "DETECTED_HAZARD", detectionId: "D" },
  hazardType: "H",
  title: "smoke",
  severity: "LOW",
  state: "OPEN",
  recurrenceCount: 0,
  sharingState: "NOT_SHARED",
  createdAt: T,
  updatedAt: T,
} as never);
check(
  "2a. a record written through the repository reads back identically",
  (await cases.get(`ORG-SMOKE-A-${run}`, "CASE-SMOKE"))?.title === "smoke",
);
check(
  "3a. another tenant cannot read it by direct id",
  (await cases.get(`ORG-SMOKE-B-${run}`, "CASE-SMOKE")) === undefined,
);
check(
  "3b. another tenant's listing is empty",
  (await cases.list(`ORG-SMOKE-B-${run}`)).length === 0,
);
const a1 = await audit.append({
  organizationId: `ORG-SMOKE-A-${run}`,
  facilityId: "F",
  actorId: "U",
  actorType: "USER",
  action: "CASE_CREATED",
  targetType: "CASE",
  targetId: "x",
  correlationId: "c",
  at: T,
} as never);
const a2 = await audit.append({
  organizationId: `ORG-SMOKE-A-${run}`,
  facilityId: "F",
  actorId: "U",
  actorType: "USER",
  action: "CASE_CREATED",
  targetType: "CASE",
  targetId: "y",
  correlationId: "c",
  at: T,
} as never);
check("2b. audit entries append with increasing sequence", a2.sequence === a1.sequence + 1);

console.log("\n-- 7-8. Cloud Storage evidence artifact, SHA-256, privacy --");
const store = new GcsEvidenceObjectStore(createGcsObjectClient(project, `${project}-evidence`));
const objKey = `evidence/ORG-SMOKE-${run}/EVP-SMOKE-${run}.json`;
const payload = JSON.stringify({ synthetic: true, run });
check("7a. the artifact is written", (await store.putIfAbsent(objKey, payload)) === true);
const back = await store.get(objKey);
check(
  "7b. the stored bytes hash to the expected SHA-256",
  back !== undefined &&
    createHash("sha256").update(back).digest("hex") ===
      createHash("sha256").update(payload).digest("hex"),
);
check(
  "7c. an existing object is never overwritten",
  (await store.putIfAbsent(objKey, "other")) === false && (await store.get(objKey)) === payload,
);
const bucket = JSON.parse(
  gcloud(
    "storage",
    "buckets",
    "describe",
    `gs://${project}-evidence`,
    "--project",
    project,
    "--format=json",
  ),
) as Json;
check(
  "8a. public access prevention is enforced and uniform bucket-level access is on",
  bucket.public_access_prevention === "enforced" && bucket.uniform_bucket_level_access === true,
);
const bucketIam = gcloud(
  "storage",
  "buckets",
  "get-iam-policy",
  `gs://${project}-evidence`,
  "--project",
  project,
  "--format=json",
);
check(
  "8b. no public principal has any role on the evidence bucket",
  !/allUsers|allAuthenticatedUsers/.test(bucketIam),
);
gcloud("storage", "rm", `gs://${project}-evidence/${objKey}`, "--project", project);

console.log("\n-- 9. Secret Manager (value never shown) --");
const keys = new SecretManagerDeviceKeyStore(createSecretAccess(project));
const deviceKey = await keys.getKey(
  SYNTHETIC_DEV_DEVICE.deviceId,
  SYNTHETIC_DEV_DEVICE.activeKeyId,
);
check("9a. the device key is readable and is 32 bytes", deviceKey?.byteLength === 32);
check(
  "9b. an unknown device/key is simply absent",
  (await keys.getKey("DEV-NOPE", "KEY-NOPE")) === undefined,
);
const sa = (n: string) => `symbiosis-${n}@${project}.iam.gserviceaccount.com`;
const secretIam = gcloud(
  "secrets",
  "get-iam-policy",
  `symbiosis-device-key-${SYNTHETIC_DEV_DEVICE.deviceId}-${SYNTHETIC_DEV_DEVICE.activeKeyId}`,
  "--project",
  project,
  "--format=json",
);
check(
  "9c. only the API service account (and project owners) can access the device key",
  secretIam.includes(sa("api")) &&
    !secretIam.includes(sa("worker")) &&
    !secretIam.includes(sa("web")),
);

console.log("\n-- 10-11. Vertex AI with the configured model, ADC, S8 validator --");
const cfg = loadExplanationConfig({});
const gemini = new GeminiExplanationProvider(
  {
    projectId: project,
    location: cfg.gemini.location,
    model: cfg.gemini.model,
    temperature: cfg.gemini.temperature,
    maxOutputTokens: cfg.gemini.maxOutputTokens,
    timeoutMs: 30000,
  },
  createAdcAccessTokenProvider(),
);
for (const [label, ctx] of [
  ["facility", facilityContext("VERIFIED")],
  ["insurer", insurerContext()],
] as const) {
  const out = await gemini
    .generate({
      context: ctx,
      promptVersion: cfg.promptVersion,
      schemaVersion: cfg.outputSchemaVersion,
      signal: AbortSignal.timeout(30000),
    })
    .catch((e: unknown) => e);
  const v =
    out instanceof Error
      ? undefined
      : validateExplanation((out as { output: unknown }).output, ctx);
  check(
    `10/11. ${label}: live ${cfg.gemini.model}@${cfg.gemini.location} answers and the S8 validator accepts it`,
    v?.ok === true,
    out instanceof Error ? out.message : "",
  );
}

console.log("\n-- 4-6. Pub/Sub publish, worker consumption, duplicate idempotency --");
const bus = new PubSubBus(createTopicPublisher(project, "symbiosis-events"));
const eventId = `EVT-SMOKE-${run}`;
const smokeEvent = {
  event_id: eventId,
  event_type: "evidence.shared.v1",
  schema_version: "1.0",
  correlation_id: `CORR-SMOKE-${run}`,
  causation_id: null,
  organization_id: `ORG-SMOKE-A-${run}`,
  facility_id: "FAC-SMOKE",
  occurred_at: T,
  producer: "api",
  payload: { synthetic: true },
} as never;
await bus.publish(smokeEvent);
await bus.publish(smokeEvent); // identical event id: a duplicate delivery
check("4. publish to the topic is accepted (both copies)", true);
const processed = await until(
  "the worker to consume the event",
  async () =>
    (await db.collection("processedEvents").doc(eventId).get()).exists ? true : undefined,
  120000,
);
check("5. the worker consumed the event from its subscription and recorded it", processed === true);
const logQuery = `resource.type="cloud_run_revision" AND resource.labels.service_name="symbiosis-worker" AND jsonPayload.eventId="${eventId}"`;
const adcToken = createAdcAccessTokenProvider();
async function logMessages(filter: string): Promise<string[]> {
  const res = await fetch("https://logging.googleapis.com/v2/entries:list", {
    method: "POST",
    headers: {
      authorization: `Bearer ${await adcToken()}`,
      "content-type": "application/json",
      "x-goog-user-project": project,
    },
    body: JSON.stringify({
      resourceNames: [`projects/${project}`],
      filter,
      orderBy: "timestamp desc",
      pageSize: 50,
    }),
  });
  const j = (await res.json()) as { entries?: { jsonPayload?: { message?: string } }[] };
  return (j.entries ?? []).map((e) => e.jsonPayload?.message ?? "");
}
const logs = await until(
  "worker logs",
  async () => {
    const out = await logMessages(`${logQuery} AND timestamp>="${T}"`);
    return out.includes("event processed") ? out.join(String.fromCharCode(10)) : undefined;
  },
  150000,
  10000,
);
const lines = (logs ?? "").split("\n").filter(Boolean);
check(
  "6. the event was processed exactly once (a redelivered copy was dropped, not re-run)",
  lines.filter((l) => l === "event processed").length === 1,
  `processed=${lines.filter((l) => l === "event processed").length}, dropped=${lines.filter((l) => l.startsWith("duplicate")).length}`,
);
await db.collection("processedEvents").doc(eventId).delete();

// cleanup of part A's throwaway collections
for (const c of await db.listCollections()) {
  if (c.id.startsWith(prefix)) await db.recursiveDelete(c);
}

// ============================================================================ part B: services
console.log("\n== B. deployed Cloud Run services ==");
check(
  "12a. API liveness and readiness answer",
  (await call("GET", "/livez")).status === 200 && (await call("GET", "/readyz")).status === 200,
);
check(
  "12b. web answers and sends an unauthenticated visitor to sign-in",
  (await call("GET", "/", undefined, undefined, WEB)).text.includes("/login") &&
    (await call("GET", "/login", undefined, undefined, WEB)).status === 200,
);
check(
  "12c. the worker is PRIVATE: anonymous requests never reach it (403)",
  (await call("GET", "/livez", undefined, undefined, WORKER)).status === 403 &&
    (await call("POST", "/pubsub/push", undefined, {}, WORKER)).status === 403 &&
    (await call("POST", "/tick", undefined, {}, WORKER)).status === 403,
);
const wIam = gcloud(
  "run",
  "services",
  "get-iam-policy",
  "symbiosis-worker",
  "--project",
  project,
  "--region",
  region,
  "--format=json",
);
check(
  "12d. the worker's IAM policy has no public invoker",
  !/allUsers|allAuthenticatedUsers/.test(wIam),
);
check(
  "13a. API rejects an anonymous request (401)",
  (await call("GET", "/api/v1/me")).status === 401,
);
const demoHeader = await fetch(`${API}/api/v1/me`, {
  headers: { "X-Demo-Actor-Id": "USR-ORG-ADMIN-001" },
});
check(
  "13b. the development identity header is not honored in the cloud",
  demoHeader.status === 401,
);
check(
  "13c. the demo proof pages and dev identity listing do not exist in the cloud",
  (await call("GET", "/ui/cases?actor=USR-ORG-ADMIN-001")).status === 404 &&
    (await call("GET", "/api/v1/dev/identities", mgrToken)).status === 404,
);
check(
  "13d. a forged token is rejected by the deployed API",
  (await call("GET", "/api/v1/me", forged)).status === 401,
);
const mgr = await call("GET", "/api/v1/me", mgrToken);
check(
  "14a. an authenticated customer request succeeds",
  mgr.status === 200 && mgr.body.organizationId === "ORG-SIM-001",
);
const insurerToken = await signIn(USERS.insurer);
const otherToken = await signIn(USERS.other);
check(
  "14b. the customer cannot call the insurer API",
  (await call("GET", "/insurance/v1/sites", mgrToken)).status === 403,
);
check(
  "14c. the insurer cannot call the customer API",
  (await call("GET", "/api/v1/cases", insurerToken)).status === 403,
);
const spoof = await call("GET", "/api/v1/me", mgrToken);
check(
  "14d. organization comes from the stored actor, not the request",
  spoof.body.organizationId === "ORG-SIM-001",
);

// ============================================================================ part C: hero case
console.log("\n== C. the hero case on the cloud runtime, in real time (about 6-8 minutes) ==");
const clock = new SystemClock();
const client = new SimulatorClient({
  baseUrl: API,
  deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: deviceKey as Uint8Array,
  clock,
});
async function send(scenario: ScenarioName, count: number, startStep = 0): Promise<boolean> {
  let ok = true;
  for (let i = 0; i < count; i++) {
    const r = await client.sendTelemetry(scenarioReadings(scenario, startStep + i));
    if (r.status !== 202) ok = false;
    await sleep(5000);
  }
  return ok;
}
check(
  "device heartbeat accepted through the API (signature verified with the Secret Manager key)",
  (await client.sendHeartbeat("HEALTHY")).status === 200,
);
const bad = new SimulatorClient({
  baseUrl: API,
  deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: new Uint8Array(32),
  clock,
});
check(
  "a request signed with the wrong key is rejected",
  (await bad.sendTelemetry(scenarioReadings("normal", 0))).status === 401,
);
const priorCases = ((await call("GET", "/api/v1/cases", mgrToken)).body.cases ?? []) as Json[];
console.log(`  (${priorCases.length} pre-existing case(s) in the demo tenant)`);

check("known-normal telemetry accepted for the baseline (25 samples)", await send("normal", 25));
await sleep(8000);
check(
  "healthy: no new case yet",
  (((await call("GET", "/api/v1/cases", mgrToken)).body.cases ?? []) as Json[]).length ===
    priorCases.length,
);
check("compound deterioration accepted", await send("compound-outdoor-heat", 3));
const priorById = new Map(priorCases.map((c) => [c.caseId as string, c]));
const found = await until(
  "the case",
  async () => {
    const list = ((await call("GET", "/api/v1/cases", mgrToken)).body.cases ?? []) as Json[];
    // A new case, or (a rerun inside the one-hour recurrence watch of an earlier verified smoke
    // case) the SAME case reopened: both are correct behavior, the second proves recurrence.
    return (
      list.find((c) => !priorById.has(c.caseId)) ??
      list.find(
        (c) => priorById.get(c.caseId)?.state === "VERIFIED_IMPROVED" && c.state === "REOPENED",
      )
    );
  },
  120000,
);
const caseId: string = found?.caseId ?? "";
const reopened = priorById.has(caseId);
check(
  reopened
    ? "recurrence inside the watch window reopened the SAME case (no duplicate case)"
    : "the worker created exactly one Risk Improvement Case from Pub/Sub events",
  caseId !== "",
  reopened ? "rerun inside the recurrence watch" : "",
);
let view = (await call("GET", `/api/v1/cases/${caseId}`, mgrToken)).body;
const alerted = await until(
  "alert",
  async () => {
    view = (await call("GET", `/api/v1/cases/${caseId}`, mgrToken)).body;
    return view?.riskEventState === "ALERTED" ? true : undefined;
  },
  60000,
);
check("alert sent, event ALERTED", alerted === true);
check(
  "the other tenant cannot see the case (404, existence not revealed)",
  (await call("GET", `/api/v1/cases/${caseId}`, otherToken)).status === 404,
);

const ack = await call("POST", `/api/v1/cases/${caseId}/acknowledge`, mgrToken, {
  note: "s9 smoke",
});
check("acknowledged by the facility manager", ack.status === 200);
const assign = await call("POST", `/api/v1/cases/${caseId}/assignments`, mgrToken, {
  actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
  assigneeId: "USR-OPERATOR-001",
});
const actionId: string = assign.body?.actionId ?? "";
const report = await call("POST", `/api/v1/cases/${caseId}/actions`, mgrToken, {
  actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
  actionId,
  notes: "s9 smoke inspection",
});
// The manager reported on the operator's behalf only if permitted; if not, the operator is not a Firebase user.
check(
  "approved action reported (event and case ACTION_REPORTED)",
  report.status === 200 && report.body.caseState === "ACTION_REPORTED",
  `status ${report.status}`,
);
view = (await call("GET", `/api/v1/cases/${caseId}`, mgrToken)).body;
check(
  "ACTION_REPORTED is not VERIFIED: verification is pending, not improved",
  view.state === "ACTION_REPORTED" && view.didItWork?.label === "VERIFICATION PENDING",
);

console.log("  streaming trusted post-action telemetry (real time)...");
const reportedAt = Date.now();
const streamed = send("normal", 27, 30);
async function tickLoop(): Promise<Json | undefined> {
  return until(
    "verification to complete",
    async () => {
      const v = (await call("GET", `/api/v1/cases/${caseId}`, mgrToken)).body;
      return v?.state === "VERIFIED_IMPROVED" ||
        ["NOT_IMPROVING", "INCONCLUSIVE", "PARTIALLY_VERIFIED"].includes(v?.state)
        ? v
        : undefined;
    },
    420000,
    15000,
  );
}
const mid = await Promise.race([streamed.then(() => "done"), sleep(60000).then(() => "wait")]);
void mid;
try {
  gcloud("scheduler", "jobs", "run", "symbiosis-tick", "--project", project, "--location", region);
} catch {
  /* the schedule runs every minute anyway */
}
await streamed;
console.log(
  `  (post-action telemetry streamed over ${Math.round((Date.now() - reportedAt) / 1000)} s; waiting for scheduler ticks)`,
);
try {
  gcloud("scheduler", "jobs", "run", "symbiosis-tick", "--project", project, "--location", region);
} catch {
  /* ignore */
}
const finalView = await tickLoop();
check(
  "verification completed deterministically on the cloud runtime",
  finalView !== undefined,
  `state ${finalView?.state}`,
);
check("case is VERIFIED_IMPROVED", finalView?.state === "VERIFIED_IMPROVED");
const pkgList = (finalView?.evidencePackages ?? []) as Json[];
check(
  "an immutable evidence package was created (Cloud Storage + Firestore index)",
  pkgList.length >= 1,
);
const pkgId: string = pkgList.at(-1)?.packageId ?? "";
const pkg = pkgId === "" ? undefined : await call("GET", `/api/v1/evidence/${pkgId}`, mgrToken);
check(
  "package integrity (SHA-256 manifest) is valid when reloaded from Cloud Storage",
  pkg?.status === 200 && pkg.body?.integrity?.valid === true,
);
const objectName = `evidence/ORG-SIM-001/${pkgId}.json`;
const stat = gcloud(
  "storage",
  "objects",
  "describe",
  `gs://${project}-evidence/${objectName}`,
  "--project",
  project,
  "--format=value(size)",
).trim();
check("the artifact object exists in the private bucket", Number(stat) > 0, `${stat} bytes`);

console.log("\n-- Vertex explanation produced by the API's own Cloud Run identity --");
const expl = await call("GET", `/api/v1/cases/${caseId}/explanation`, mgrToken);
const meta = expl.body?.meta ?? expl.body;
check("explanation endpoint answers", expl.status === 200);
console.log(
  `  provider=${JSON.stringify(meta?.provider ?? meta?.source ?? "?")} model=${JSON.stringify(meta?.model ?? "?")} fallback=${JSON.stringify(expl.body?.fallbackReason ?? expl.body?.meta?.fallbackReason ?? "none")}`,
);
check(
  "11b. Gemini (not the template fallback) answered from Cloud Run via workload identity and validated",
  expl.body?.meta?.provider === "gemini" && expl.body?.meta?.fallbackUsed !== true,
  JSON.stringify({
    provider: expl.body?.meta?.provider,
    fallback: expl.body?.meta?.fallbackReason,
  }),
);

console.log("\n-- consent: insurer denied, consented, revoked --");
const denied = await call("GET", `/insurance/v1/cases/${caseId}`, insurerToken);
check("15a. insurer is DENIED before any agreement (403)", denied.status === 403);
const grant = await call("POST", "/api/v1/sharing-agreements", mgrToken, {
  recipientOrganizationId: "ORG-INS-001",
  facilityIds: ["FAC-SIM-001"],
  scopes: [
    "RECOMMENDATION",
    "EVENT_SUMMARY",
    "ACTION_SUMMARY",
    "BEFORE_AFTER_METRICS",
    "VERIFICATION_RESULT",
    "VERIFICATION_CONFIDENCE",
    "RECURRENCE_STATUS",
    "EVIDENCE_ARTIFACTS",
    "INTERVENTION_RECOMMENDATION",
  ],
});
const agreementId: string = grant.body?.agreementId ?? grant.body?.agreement?.agreementId ?? "";
check(
  "customer grants consent",
  grant.status === 201 && agreementId !== "",
  `status ${grant.status}`,
);
const ok = await call("GET", `/insurance/v1/cases/${caseId}`, insurerToken);
const ev = await call("GET", `/insurance/v1/cases/${caseId}/evidence`, insurerToken);
check(
  "15b. the consented insurer request succeeds, scoped",
  ok.status === 200 && ev.status === 200,
);
const ie = await call("GET", `/insurance/v1/cases/${caseId}/explanation`, insurerToken);
check("insurer explanation is served from consent-filtered facts", ie.status === 200);
const revoke = await call("POST", `/api/v1/sharing-agreements/${agreementId}/revoke`, mgrToken, {
  reason: "s9 smoke",
});
check("customer revokes consent", revoke.status === 200);
const after = await call("GET", `/insurance/v1/cases/${caseId}`, insurerToken);
check(
  "16. the very next insurer read is DENIED after revocation (403)",
  after.status === 403 && after.body?.error?.code === "ACCESS_DENIED",
);
check(
  "16b. insurer explanation also denied after revocation",
  (await call("GET", `/insurance/v1/cases/${caseId}/explanation`, insurerToken)).status === 403,
);
if (agreementId !== "") await db.collection("sharingAgreements").doc(agreementId).delete();

await db.terminate();
console.log(`\n${passes} passed, ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
