import { FakeEmailTransport } from "@symbiosis/adapter-email";
import { ManualClock } from "@symbiosis/clock";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { createLocalRuntime } from "./local-runtime";

/**
 * S10 local smoke: the whole closed loop through the REAL pipeline over real HTTP, on simulated
 * time. Facility Simulation session -> signed vendor payloads -> versioned adapter -> canonical
 * observation -> quality -> deterministic rule -> case -> alert email -> acknowledgement -> action ->
 * post-action telemetry -> verification -> follow-up (ineffective) or VERIFIED -> evidence ->
 * consent and revocation -> recurrence. It also proves the adapter trace and the provenance labels.
 * Nothing here creates a case or a verification: it sets the physical world and clicks as people.
 * Exits non-zero on any failed assertion.
 */
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

const ORG = "ORG-SIM-001";
const FAC = "FAC-SIM-PHX-01";
const ADMIN = "USR-ORG-ADMIN-001";
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const INSURER = "USR-RISK-ENGINEER-001";
const OTHER = "USR-OTHER-ORG-MGR-001";
const BACKUP = "ACT-COOLING-START-BACKUP";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

type Json = ReturnType<typeof JSON.parse>;

const clock = new ManualClock(Date.parse("2026-10-02T10:00:00.000Z"));
const transport = new FakeEmailTransport();
const runtime = await createLocalRuntime({
  clock,
  ids: new SequentialIdGenerator(),
  consoleSink: () => {},
  emailTransport: transport,
  webBaseUrl: "https://app.example",
});
const base = runtime.server.baseUrl;

async function api(method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Demo-Actor-Id": actor,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Json };
}
const sim = (method: string, rest: string, actor = ADMIN, body?: unknown) =>
  api(method, `/api/v1/simulation${rest}`, actor, body);

async function steps(count: number, tick = true) {
  for (let i = 0; i < count; i += 1) {
    clock.advance(5000);
    const r = await sim("POST", "/pulse", ADMIN, {});
    if (r.status !== 200 || (r.body.rejected as unknown[]).length > 0) {
      throw new Error(`pulse failed: ${JSON.stringify(r.body)}`);
    }
    if (tick) await runtime.tick();
  }
}
async function until(predicate: () => Promise<boolean>, max: number, tick = true) {
  for (let i = 0; i < max; i += 1) {
    if (await predicate()) return true;
    await steps(1, tick);
  }
  return predicate();
}
const cases = () => runtime.cases.list(ORG).then((l) => l.filter((c) => c.facilityId === FAC));
const completed = async (caseId: string) =>
  (await runtime.verifications.listByCase(ORG, caseId)).filter((v) => v.status === "COMPLETED");
const results = async (caseId: string) =>
  (await completed(caseId)).map((v) => v.assessment?.result);
const emails = (prefix: string) => transport.outbox.filter((m) => m.subject.startsWith(prefix));

async function reportAction(caseId: string, library: string, acknowledge: boolean) {
  if (acknowledge) await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
  const a = await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
    actionLibraryId: library,
    assigneeId: OPERATOR,
  });
  return api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
    actionLibraryId: library,
    actionId: a.body.actionId,
    notes: "done",
  });
}

try {
  // 1. source payload -> adapter -> canonical (the Integration Lab path, before anything is ingested)
  const profiles = (await sim("GET", "/adapters")).body.profiles as Json[];
  check("synthetic vendor profiles are listed with versioned mappings", profiles.length >= 3);
  const flat = profiles.find((p) => p.profileId === "sim-bas-gateway");
  check(
    "a profile shows its source payload and declarative mapping",
    flat?.samplePayload !== null && (flat?.mapping as unknown[]).length > 0,
  );
  const prev = await sim("POST", "/adapters/preview", ADMIN, { profileId: "sim-bas-gateway" });
  check(
    "dry-run adapter trace accepts fields into canonical observations",
    prev.status === 200 &&
      (prev.body.observations as Json[]).length > 0 &&
      prev.body.trace.fields.every((f: Json) => f.status === "ACCEPTED"),
  );
  const cmp = (await sim("GET", "/adapters/compare")).body;
  check(
    "two differently shaped vendor payloads are equivalent canonically",
    cmp.equivalent === true,
  );

  // 2. baseline from normal telemetry; nothing opens
  check("session starts", (await sim("POST", "/session/start")).status === 200);
  await sim("POST", "/scenario", ADMIN, { scenarioId: "NORMAL", weatherMode: "SIMULATED" });
  const ready = await until(
    async () => (await sim("GET", "")).body.baseline.ready === true,
    60,
    false,
  );
  check("baselines become READY from signed vendor telemetry", ready);
  await steps(6);
  check(
    "NORMAL opens no case and sends no email",
    (await cases()).length === 0 && transport.outbox.length === 0,
  );

  // provenance of what was ingested
  const obs = await runtime.observations.list(ORG);
  const sample = obs.find((o) => o.signal === "vibration_rms");
  check(
    "ingested observations are signed, adapter-attributed and labelled SIMULATOR",
    sample !== undefined &&
      sample.sourceType === "SIMULATOR" &&
      sample.quality.authVerified === true &&
      sample.sourceAdapter.length > 0,
    `${sample?.sourceType}/${sample?.sourceAdapter}`,
  );
  const traces = (await sim("GET", "/adapters")).body.profiles.flatMap(
    (p: Json) => p.recentTraces as Json[],
  );
  check(
    "ingested payloads left INGESTED adapter traces with the mapping version and a synthetic label",
    traces.length > 0 &&
      traces.every(
        (t: Json) => t.mode === "INGESTED" && typeof t.version === "number" && t.synthetic === true,
      ),
  );

  // 3. compound risk -> one case -> one alert
  await sim("POST", "/scenario", ADMIN, { scenarioId: "COMPOUND_COOLING_RISK" });
  await until(async () => (await cases()).length > 0, 60, false);
  const [theCase] = await cases();
  const caseId = (theCase as { caseId: string }).caseId;
  check("persistent compound condition opens exactly one case", (await cases()).length === 1);
  check(
    "one alert email, sent through the channel to the facility manager",
    emails("[ALERT]").length === 1,
  );
  const ov = (await sim("GET", "")).body;
  check(
    "the rule version recorded is the DEMO / SIMULATION policy",
    ov.rule.ruleVersion === "sim.1",
  );

  // 4. acknowledge + report; ineffective -> NOT_IMPROVING -> one follow-up
  const rep = await reportAction(caseId, BACKUP, true);
  check("acknowledge, assign and report succeed", rep.status === 200);
  check("a reported action is NOT verified", (await completed(caseId)).length === 0);
  await sim("POST", "/scenario", ADMIN, { scenarioId: "INEFFECTIVE_MITIGATION" });
  await until(async () => (await completed(caseId)).length >= 1, 80);
  check(
    "ineffective action -> NOT_IMPROVING",
    (await results(caseId))[0] === "NOT_IMPROVING",
    String((await results(caseId))[0]),
  );
  await steps(8);
  check("exactly one follow-up email", emails("[FOLLOW-UP]").length === 1);

  // 5. successful mitigation -> VERIFIED -> evidence labelled as simulation data
  await reportAction(caseId, INSPECT, false);
  await sim("POST", "/scenario", ADMIN, { scenarioId: "SUCCESSFUL_MITIGATION" });
  await until(async () => (await completed(caseId)).length >= 2, 100);
  check(
    "genuine improvement -> VERIFIED through the lifecycle",
    (await results(caseId))[1] === "VERIFIED",
  );
  const pkgs = await runtime.evidencePackages.listByCase(ORG, caseId);
  const loaded = await runtime.evidenceService.load(ORG, pkgs[pkgs.length - 1]?.packageId ?? "");
  check(
    "evidence is labelled SYNTHETIC_SIMULATOR and keeps the policy version",
    loaded.ok &&
      loaded.value.package.payload.source.dataOrigin === "SYNTHETIC_SIMULATOR" &&
      loaded.value.package.payload.source.synthetic === true &&
      loaded.value.package.payload.verification.policyVersion === "sim.1",
  );

  // 6. consent, tenant boundary, revocation
  check(
    "no consent -> insurer denied",
    (await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER)).status === 403,
  );
  const grant = await api("POST", "/api/v1/sharing-agreements", MGR, {
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
  const shared = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER);
  check(
    "consent -> insurer sees the result with a simulation label, never raw telemetry",
    grant.status === 201 &&
      shared.status === 200 &&
      /SYNTHETIC|simulat/i.test(JSON.stringify(shared.body)) &&
      (await api("GET", `/insurance/v1/cases/${caseId}/evidence?include=raw_telemetry`, INSURER))
        .status === 403,
  );
  check(
    "another tenant cannot read or control the case or the simulation",
    (await api("GET", `/api/v1/cases/${caseId}`, OTHER)).status === 404 &&
      (await sim("POST", "/reset", OTHER, { confirm: "RESET" })).status === 404,
  );
  const revoked = await api(
    "POST",
    `/api/v1/sharing-agreements/${grant.body.agreement.agreementId}/revoke`,
    MGR,
    { reason: "smoke" },
  );
  check(
    "revocation removes insurer access immediately",
    revoked.status === 200 &&
      (await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER)).status === 403,
  );

  // 7. recurrence: same case reopened, one recurrence notice, evidence kept
  const before = pkgs.length;
  await sim("POST", "/scenario", ADMIN, { scenarioId: "RECURRENCE" });
  await until(async () => (await runtime.cases.get(ORG, caseId))?.state === "REOPENED", 60);
  const after = await cases();
  check(
    "recurrence reopens the SAME case (no duplicate)",
    after.length === 1 && after[0]?.caseId === caseId && after[0]?.recurrenceCount === 1,
  );
  check("one recurrence notification", emails("[RECURRENCE]").length === 1);
  check(
    "a new risk event exists and prior evidence is retained",
    (await runtime.riskEvents.listByCase(ORG, caseId)).length === 2 &&
      (await runtime.evidencePackages.listByCase(ORG, caseId)).length >= before,
  );

  // 8. reset affects only the simulation facility
  const reset = await sim("POST", "/reset", ADMIN, { confirm: "RESET" });
  check(
    "reset clears only the simulation facility",
    reset.status === 200 && (await cases()).length === 0,
  );
} finally {
  await runtime.close();
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
