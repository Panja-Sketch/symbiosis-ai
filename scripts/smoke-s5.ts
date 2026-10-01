import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { createLocalRuntime } from "./local-runtime";
import type { LocalRuntime } from "./local-runtime";

/**
 * S5 smoke test: the physical verification loop and recurrence, end to end over real HTTP with
 * simulated time. baseline -> risk -> one case -> alert -> acknowledge -> approved action reported
 * (VERIFICATION PENDING) -> trusted post-action telemetry -> deterministic verification ->
 * VERIFIED_IMPROVED -> continued monitoring -> the hazard returns -> the SAME case is REOPENED.
 * Then the negative paths: an action report alone, or untrusted/missing data, never verifies.
 * Exits non-zero on any failed assertion.
 */
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const ADMIN = "USR-ORG-ADMIN-001";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

type Json = ReturnType<typeof JSON.parse>;

async function world() {
  const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  const runtime: LocalRuntime = await createLocalRuntime({ clock, consoleSink: () => {} });
  const base = runtime.server.baseUrl;
  const client = new SimulatorClient({
    baseUrl: base,
    deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
    keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
    key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
    clock,
    initialSeq: 1,
  });
  const api = async (method: string, path: string, actor: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "X-Demo-Actor-Id": actor,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const send = async (scenario: ScenarioName, count: number): Promise<boolean> => {
    let accepted = true;
    for (let i = 0; i < count; i++) {
      if ((await client.sendTelemetry(scenarioReadings(scenario, i))).status !== 202) {
        accepted = false;
      }
      clock.advance(5000);
    }
    return accepted;
  };
  const types = () => runtime.bus.history().map((e) => e.event_type as string);
  const tick = async () => (await api("POST", "/api/v1/ops/tick", ADMIN, {})).body;
  return { clock, runtime, base, client, api, send, types, tick };
}
type World = Awaited<ReturnType<typeof world>>;

async function reportAction(w: World, caseId: string, acknowledge: boolean) {
  if (acknowledge) await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
  const assign = await w.api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
    actionLibraryId: INSPECT,
    assigneeId: OPERATOR,
  });
  const actionId = assign.body.actionId as string;
  await w.api("POST", `/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR, {});
  const report = await w.api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
    actionLibraryId: INSPECT,
    actionId,
    notes: "Inspected the primary cooling assembly.",
  });
  return { assign, report, actionId };
}

// ===================================================================================== main loop
const w = await world();
console.log(`runtime listening on ${w.base} (simulated time, development identity)\n`);
check("heartbeat accepted", (await w.client.sendHeartbeat("HEALTHY")).status === 200);

console.log("\n-- 1-2: baseline, then prove a healthy state --");
check(
  "1. 25 known-normal samples accepted over signed HTTP (baseline learned)",
  await w.send("normal", 25),
);
check(
  "2. healthy: no case and no recommendation yet",
  (await w.runtime.cases.list(ORG)).length === 0 &&
    (await w.runtime.interventions.list(ORG)).length === 0,
);

console.log("\n-- 3-4: persistent risk -> exactly one case --");
check("3. compound deterioration accepted", await w.send("compound-outdoor-heat", 3));
const cases = await w.runtime.cases.list(ORG);
const caseId = cases[0]?.caseId ?? "";
check("4. exactly one Risk Improvement Case", cases.length === 1);
const firstEventId = cases[0]?.activeRiskEventId ?? "";

console.log("\n-- 5-8: alert, acknowledge, approved action, VERIFICATION PENDING --");
let view = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body;
check("5. alert sent, event ALERTED", view.riskEventState === "ALERTED");
const ack = await w.api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, { note: "smoke" });
check(
  "6. acknowledged by the facility manager",
  ack.status === 200 && ack.body.riskEventState === "ACKNOWLEDGED",
);
const { assign, report } = await reportAction(w, caseId, false);
check(
  "7. approved action assigned and reported (event+case ACTION_REPORTED)",
  assign.status === 201 &&
    report.status === 200 &&
    report.body.caseState === "ACTION_REPORTED" &&
    report.body.riskEventState === "ACTION_REPORTED",
);
view = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body;
check("8. case shows VERIFICATION PENDING", view.didItWork.label === "VERIFICATION PENDING");
check(
  "14. the action report itself created no verification (no id, no event, not VERIFIED_IMPROVED)",
  (await w.runtime.cases.get(ORG, caseId))?.latestVerificationId === undefined &&
    !w.types().some((t) => t.startsWith("verification.")) &&
    view.state === "ACTION_REPORTED",
);

console.log("\n-- 9-12: trusted post-action telemetry -> deterministic verification --");
const started = await w.tick(); // scheduler pass: verification starts for the reported action
check(
  "10a. verification.started (case VERIFYING, still pending)",
  started.verification.started.length === 1 &&
    (await w.runtime.cases.get(ORG, caseId))?.state === "VERIFYING",
);
check("9. 25 trusted, healthy post-action samples accepted", await w.send("normal", 25));
const done = await w.tick();
check("10b. verification.completed", done.verification.completed.length === 1);
check("11. result VERIFIED", done.verification.completed[0]?.result === "VERIFIED");
const cs = await w.runtime.cases.get(ORG, caseId);
check("12. case VERIFIED_IMPROVED", cs?.state === "VERIFIED_IMPROVED");
const attempt = (await w.runtime.verifications.listByCase(ORG, caseId))[0];
const evidence = await w.runtime.resolveEvidence(attempt?.verificationId ?? "", ORG);
check(
  "13. every evidence ID resolves to a real record",
  evidence.length > 0 && evidence.every((e) => e.exists),
  `${evidence.length} references`,
);
const kinds = [...new Set(evidence.map((e) => e.kind))].sort().join(",");
console.log(`  evidence kinds: ${kinds}`);
const verApi = await w.api("GET", `/api/v1/verifications/${attempt?.verificationId}`, MGR);
check(
  "API: verification record readable with policy id/version and criteria",
  verApi.status === 200 &&
    verApi.body.policyId === "VPOL-COOLING-ELECTRICAL" &&
    verApi.body.assessment.requiredCriteria.length >= 4,
);
const ints = (await w.api("GET", "/api/v1/interventions", MGR)).body.interventions as Json[];
const active = ints.find((i) => i.status === "ACTIVE");
check(
  "15. intervention recommendation recalculated after verification (old superseded, new ACTIVE)",
  ints.length >= 2 &&
    ints.some((i) => i.status === "SUPERSEDED") &&
    active?.level === "REMOTE_MONITORING" &&
    active.reasonCodes.includes("IMPROVEMENT_CONFIRMED_UNDER_RECURRENCE_WATCH"),
);
view = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body;
const page = await (await fetch(`${w.base}/ui/cases/${caseId}?actor=${MGR}`)).text();
check(
  "UI shows VERIFIED IMPROVED, policy, recurrence watch and the recommendation",
  page.includes("VERIFIED IMPROVED") &&
    page.includes("VPOL-COOLING-ELECTRICAL") &&
    page.includes("WATCHING") &&
    page.includes("Remote Monitoring"),
);

console.log("\n-- 16-17: continued monitoring keeps the case verified --");
check("16. 12 more normal samples accepted", await w.send("normal", 12));
check(
  "17. case remains VERIFIED_IMPROVED, no recurrence",
  (await w.runtime.cases.get(ORG, caseId))?.state === "VERIFIED_IMPROVED" &&
    !w.types().includes("recurrence.detected.v1"),
);

console.log("\n-- 18-23: the hazard returns inside the recurrence window --");
await w.send("isolated-vibration", 4);
check(
  "a single abnormal signal (WATCH) does not reopen the case",
  (await w.runtime.cases.get(ORG, caseId))?.state === "VERIFIED_IMPROVED",
);
await w.send("normal", 3);
check("18. qualifying deterioration accepted", await w.send("compound-outdoor-heat", 3));
check(
  "19. recurrence.detected emitted",
  w.types().filter((t) => t === "recurrence.detected.v1").length === 1,
);
const after = await w.runtime.cases.get(ORG, caseId);
check("20. the SAME case is REOPENED", after?.caseId === caseId && after.state === "REOPENED");
check("21. recurrence count incremented", after?.recurrenceCount === 1);
const events = await w.runtime.riskEvents.listByCase(ORG, caseId);
check(
  "22. a new RiskEvent exists; the first is preserved as VERIFIED",
  events.length === 2 &&
    after?.activeRiskEventId !== firstEventId &&
    events.find((e) => e.eventId === firstEventId)?.state === "VERIFIED",
);
check("23. no duplicate Risk Improvement Case", (await w.runtime.cases.list(ORG)).length === 1);
check(
  "prior verification history intact",
  (await w.runtime.verifications.listByCase(ORG, caseId)).length === 1 &&
    (await w.runtime.verifications.get(ORG, attempt?.verificationId ?? ""))?.assessment?.result ===
      "VERIFIED",
);
view = (await w.api("GET", `/api/v1/cases/${caseId}`, MGR)).body;
check(
  "intervention escalates to Risk Engineer Review after the recurrence",
  view.intervention?.level === "RISK_ENGINEER_REVIEW" && view.stayingFixed.recurrenceCount === 1,
);
check("no dead-lettered events", w.runtime.bus.deadLetters().length === 0);
console.log(
  `  S5 event order: ${w
    .types()
    .filter((t) =>
      /^(action\.reported|verification|recurrence|case\.reopened|intervention)/.test(t),
    )
    .join(" > ")}`,
);
await w.runtime.close();

// ================================================================================ negative paths
console.log("\n-- negative paths: a report alone, or missing/untrusted data, never verifies --");
{
  const n = await world();
  await n.client.sendHeartbeat("HEALTHY");
  await n.send("normal", 25);
  await n.send("compound-outdoor-heat", 3);
  const id = (await n.runtime.cases.list(ORG))[0]?.caseId ?? "";
  await reportAction(n, id, true);
  await n.tick();
  n.clock.advance(200_000);
  await n.tick();
  const c = await n.runtime.cases.get(ORG, id);
  check(
    "action report + no post-action telemetry => INCONCLUSIVE, never VERIFIED",
    c?.state === "INCONCLUSIVE",
  );
  await n.runtime.close();
}
{
  const n = await world();
  await n.client.sendHeartbeat("HEALTHY");
  await n.send("normal", 25);
  await n.send("compound-outdoor-heat", 3);
  const id = (await n.runtime.cases.list(ORG))[0]?.caseId ?? "";
  await reportAction(n, id, true);
  await n.tick();
  await n.client.sendHeartbeat("FAULT");
  await n.send("normal", 25);
  await n.tick();
  check(
    "action report + unhealthy required device => INCONCLUSIVE, never VERIFIED",
    (await n.runtime.cases.get(ORG, id))?.state === "INCONCLUSIVE",
  );
  await n.runtime.close();
}
{
  const n = await world();
  await n.client.sendHeartbeat("HEALTHY");
  await n.send("normal", 25);
  await n.send("compound-outdoor-heat", 3);
  const id = (await n.runtime.cases.list(ORG))[0]?.caseId ?? "";
  await reportAction(n, id, true);
  await n.tick();
  await n.send("compound-outdoor-heat", 25);
  await n.tick();
  const c = await n.runtime.cases.get(ORG, id);
  check(
    "trusted evidence that remains abnormal => NOT_IMPROVING (not INCONCLUSIVE)",
    c?.state === "NOT_IMPROVING",
  );
  const followUp = await reportAction(n, id, false);
  check(
    "a NOT_IMPROVING case is not closed: a follow-up approved action can be reported",
    followUp.report.status === 200 && followUp.report.body.caseState === "ACTION_REPORTED",
  );
  await n.runtime.close();
}

console.log(`\n${passes} PASS, ${failures} FAIL`);
console.log(failures === 0 ? "SMOKE TEST S5 PASSED" : `SMOKE TEST S5 FAILED (${failures})`);
// Set exitCode and let the loop drain; process.exit() while sockets close crashes Node on Windows.
process.exitCode = failures === 0 ? 0 : 1;
