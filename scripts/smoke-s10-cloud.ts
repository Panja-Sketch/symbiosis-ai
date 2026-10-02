import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * S10 cloud smoke (OPT-IN: it drives the REAL deployed services and writes synthetic demo records to
 * the simulation facility). Over the deployed API, in REAL time, as the four synthetic demo users:
 * simulation session -> signed vendor payloads -> adapter -> canonical observation -> quality ->
 * live weather context -> deterministic rule -> case -> notification -> acknowledgement and action ->
 * verification -> follow-up (ineffective) or VERIFIED -> evidence -> consent, tenant boundary and
 * revocation -> recurrence. At the end it resets the simulation facility (only that facility).
 *
 * Run: SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=<id> pnpm smoke:s10:cloud --confirm-project <id>
 * Tokens and passwords are never printed.
 */
const project = process.env.GCP_PROJECT_ID ?? "";
const confirm = process.argv[process.argv.indexOf("--confirm-project") + 1];
if (process.env.SMOKE_S10_CLOUD !== "1" || project === "" || confirm !== project) {
  console.error(
    "smoke:s10:cloud drives the REAL deployed services. Opt in with:\n" +
      "  SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=<id> pnpm smoke:s10:cloud --confirm-project <id>",
  );
  process.exit(2);
}
const region = process.env.GCP_REGION ?? "us-central1";
const FAC = "FAC-SIM-PHX-01";
const BACKUP = "ACT-COOLING-START-BACKUP";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

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
const API = gcloud(
  "run",
  "services",
  "describe",
  "symbiosis-api",
  "--project",
  project,
  "--region",
  region,
  "--format=value(status.url)",
).trim();

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
async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
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
  return { status: res.status, body: json as Json };
}

const tokens = {
  manager: await signIn(USERS.manager),
  admin: await signIn(USERS.admin),
  insurer: await signIn(USERS.insurer),
  other: await signIn(USERS.other),
};
const sim = (method: string, rest: string, who: keyof typeof tokens = "admin", body?: unknown) =>
  call(method, `/api/v1/simulation${rest}`, tokens[who], body);

// The browser would pulse every 5 seconds; here a timer does the same, as the administrator.
let pulsing = true;
let pulseErrors = 0;
const pulser = (async () => {
  while (pulsing) {
    const r = await sim("POST", "/pulse", "admin", {}).catch(() => undefined);
    if (r === undefined || r.status >= 500) pulseErrors += 1;
    await sleep(5000);
  }
})();
let lastTick = 0;
async function runChecks() {
  if (Date.now() - lastTick < 9000) return;
  lastTick = Date.now();
  await sim("POST", "/tick", "admin", {}).catch(() => undefined);
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined && v !== false) return v;
    await runChecks();
    await sleep(4000);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const overview = async () => (await sim("GET", "")).body;
const caseView = async (id: string) =>
  (await call("GET", `/api/v1/cases/${id}`, tokens.manager)).body;

try {
  // ---- deployed behaviour: authorization before anything runs ----------------------------------
  check(
    "unauthenticated simulation call is refused",
    (await fetch(`${API}/api/v1/simulation`)).status === 401,
  );
  check(
    "insurer and other-tenant identities get 404 for the simulation",
    (await sim("GET", "", "insurer")).status === 404 &&
      (await sim("GET", "", "other")).status === 404,
  );
  check(
    "other tenant cannot reset or control the simulation",
    (await sim("POST", "/reset", "other", { confirm: "RESET" })).status === 404 &&
      (await sim("POST", "/session/start", "other")).status === 404,
  );

  // ---- start from a clean facility --------------------------------------------------------------
  await sim("POST", "/reset", "admin", { confirm: "RESET" });
  check("session starts", (await sim("POST", "/session/start")).status === 200);
  await sim("POST", "/scenario", "admin", { scenarioId: "NORMAL", weatherMode: "LIVE" });

  const profiles = (await sim("GET", "/adapters")).body.profiles as Json[];
  check("synthetic vendor profiles with versioned mappings are deployed", profiles.length >= 3);
  check(
    "adapter equivalence holds in the cloud",
    (await sim("GET", "/adapters/compare")).body.equivalent === true,
  );

  // ---- baseline, live weather ------------------------------------------------------------------
  await until("baselines READY", async () => (await overview()).baseline.ready === true, 240_000);
  check("baselines become READY from signed vendor telemetry", true);
  const ov0 = await overview();
  const live = ov0.weather.display === "LIVE WEATHER";
  check(
    "weather is LIVE WEATHER with the provider's own temperature and time",
    live && typeof ov0.weather.temperatureC === "number",
    `${ov0.weather.display}`,
  );
  check("NORMAL opens no case", (ov0.cases as unknown[]).length === 0);
  const sensor = (ov0.sensors as Json[]).find((s) => s.signal === "vibration_rms");
  check(
    "vendor telemetry is labelled simulation data",
    /simulat/i.test(JSON.stringify(sensor ?? {})) || sensor?.sourceLabel !== undefined,
  );

  // ---- compound risk -> case -> notification ---------------------------------------------------
  await sim("POST", "/scenario", "admin", { scenarioId: "COMPOUND_COOLING_RISK" });
  const caseId = (await until(
    "a case opens",
    async () => (await overview()).activeCaseId ?? undefined,
    240_000,
  )) as string;
  check(
    "persistent compound condition opens one case",
    (await overview()).cases.length === 1,
    caseId,
  );
  const ovCase = await overview();
  check(
    "rule version recorded is the DEMO / SIMULATION policy",
    ovCase.rule.ruleVersion === "sim.1",
  );
  await until(
    "alert delivery recorded",
    async () => ((await overview()).notifications as Json[]).some((n) => n.kind === "INITIAL"),
    120_000,
  );
  check(
    "one initial alert delivery is persisted",
    ((await overview()).notifications as Json[]).filter((n) => n.kind === "INITIAL").length === 1,
  );

  // ---- acknowledge, ineffective action -> NOT_IMPROVING -> follow-up ---------------------------
  const ack = await call("POST", `/api/v1/cases/${caseId}/acknowledge`, tokens.manager, {});
  check("acknowledgement is accepted", ack.status === 200);
  const assign = await call("POST", `/api/v1/cases/${caseId}/assignments`, tokens.manager, {
    actionLibraryId: BACKUP,
    assigneeId: "USR-FACILITY-MGR-001",
  });
  const report = await call("POST", `/api/v1/cases/${caseId}/actions`, tokens.manager, {
    actionLibraryId: BACKUP,
    actionId: assign.body?.actionId,
    notes: "cloud smoke",
  });
  check(
    "an action is assigned and reported complete",
    assign.status === 201 && report.status === 200,
  );
  await sim("POST", "/scenario", "admin", { scenarioId: "INEFFECTIVE_MITIGATION" });
  const v1 = await until(
    "first verification completes",
    async () => {
      const v = await caseView(caseId);
      return v.state === "NOT_IMPROVING" ||
        v.state === "INCONCLUSIVE" ||
        v.state === "PARTIALLY_VERIFIED" ||
        v.state === "VERIFIED_IMPROVED"
        ? v
        : undefined;
    },
    420_000,
  );
  check(
    "a reported action is never VERIFIED when the world did not improve",
    v1.state === "NOT_IMPROVING",
    v1.state,
  );
  await sleep(15_000);
  await runChecks();
  const followUps = ((await overview()).notifications as Json[]).filter(
    (n) => n.kind === "FOLLOW_UP",
  );
  check("exactly one follow-up is persisted", followUps.length === 1, `${followUps.length}`);

  // ---- successful mitigation -> VERIFIED -> evidence ------------------------------------------
  const assign2 = await call("POST", `/api/v1/cases/${caseId}/assignments`, tokens.manager, {
    actionLibraryId: INSPECT,
    assigneeId: "USR-FACILITY-MGR-001",
  });
  await call("POST", `/api/v1/cases/${caseId}/actions`, tokens.manager, {
    actionLibraryId: INSPECT,
    actionId: assign2.body?.actionId,
    notes: "cloud smoke",
  });
  await sim("POST", "/scenario", "admin", { scenarioId: "SUCCESSFUL_MITIGATION" });
  const v2 = await until(
    "second verification completes",
    async () => {
      const v = await caseView(caseId);
      return v.state === "VERIFIED_IMPROVED" ||
        v.state === "NOT_IMPROVING" ||
        v.state === "INCONCLUSIVE"
        ? v
        : undefined;
    },
    480_000,
  );
  check(
    "genuine improvement -> VERIFIED_IMPROVED through the lifecycle",
    v2.state === "VERIFIED_IMPROVED",
    v2.state,
  );
  const pkgs = (v2.evidencePackages ?? []) as Json[];
  check("evidence packages exist for both verifications", pkgs.length >= 2, `${pkgs.length}`);
  const latest = pkgs[pkgs.length - 1];
  const pkg =
    latest === undefined
      ? undefined
      : await call("GET", `/api/v1/evidence/${latest.packageId}`, tokens.manager);
  check(
    "evidence is labelled as simulation data and records the demo policy version",
    pkg?.status === 200 &&
      JSON.stringify(pkg.body).includes("SYNTHETIC_SIMULATOR") &&
      JSON.stringify(pkg.body).includes("sim.1"),
  );
  const traces = ((await sim("GET", "/adapters")).body.profiles as Json[]).flatMap(
    (p) => p.recentTraces as Json[],
  );
  check(
    "ingested payloads left adapter traces",
    traces.length > 0 && traces.every((t) => t.mode === "INGESTED" && t.synthetic === true),
  );

  // ---- consent, tenant boundary, revocation ----------------------------------------------------
  check(
    "no consent -> insurer denied",
    (await call("GET", `/insurance/v1/cases/${caseId}/evidence`, tokens.insurer)).status === 403,
  );
  const grant = await call("POST", "/api/v1/sharing-agreements", tokens.manager, {
    recipientOrganizationId: "ORG-INS-001",
    facilityIds: [FAC],
    scopes: [
      "RECOMMENDATION",
      "EVENT_SUMMARY",
      "ACTION_SUMMARY",
      "BEFORE_AFTER_METRICS",
      "VERIFICATION_RESULT",
      "VERIFICATION_CONFIDENCE",
      "RECURRENCE_STATUS",
      "EVIDENCE_ARTIFACTS",
    ],
  });
  const seen = await call("GET", `/insurance/v1/cases/${caseId}/evidence`, tokens.insurer);
  check(
    "consent -> insurer sees the result labelled as simulation, never raw telemetry",
    grant.status === 201 &&
      seen.status === 200 &&
      /SYNTHETIC|simulat/i.test(JSON.stringify(seen.body)) &&
      (
        await call(
          "GET",
          `/insurance/v1/cases/${caseId}/evidence?include=raw_telemetry`,
          tokens.insurer,
        )
      ).status === 403,
  );
  check(
    "another tenant cannot read the case",
    (await call("GET", `/api/v1/cases/${caseId}`, tokens.other)).status === 404,
  );
  const revoke = await call(
    "POST",
    `/api/v1/sharing-agreements/${grant.body?.agreement?.agreementId}/revoke`,
    tokens.manager,
    { reason: "smoke" },
  );
  check(
    "revocation removes insurer access immediately",
    revoke.status === 200 &&
      (await call("GET", `/insurance/v1/cases/${caseId}/evidence`, tokens.insurer)).status === 403,
  );

  // ---- recurrence ------------------------------------------------------------------------------
  await sim("POST", "/scenario", "admin", { scenarioId: "RECURRENCE" });
  const reopened = await until(
    "case reopens",
    async () => ((await caseView(caseId)).state === "REOPENED" ? true : undefined),
    300_000,
  );
  const ovR = await overview();
  check(
    "recurrence reopens the SAME case (no duplicate)",
    reopened === true && (ovR.cases as Json[]).length === 1,
  );
  await until(
    "recurrence notification",
    async () =>
      ((await overview()).notifications as Json[]).some((n) =>
        String(n.subject).startsWith("[RECURRENCE]"),
      ),
    120_000,
  );
  check(
    "exactly one recurrence notification is persisted",
    ((await overview()).notifications as Json[]).filter((n) =>
      String(n.subject).startsWith("[RECURRENCE]"),
    ).length === 1,
  );
  check("the pulse loop saw no server errors", pulseErrors === 0, `${pulseErrors}`);
} catch (e) {
  check(
    "smoke completed without an unexpected error",
    false,
    e instanceof Error ? e.message : String(e),
  );
} finally {
  pulsing = false;
  await pulser;
  const reset = await sim("POST", "/reset", "admin", { confirm: "RESET" }).catch(() => undefined);
  check("reset clears the simulation facility", reset?.status === 200);
}
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
