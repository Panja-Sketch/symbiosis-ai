import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { createLocalRuntime } from "./local-runtime";

/**
 * S4 smoke test: the human operations workflow end to end over real HTTP, with simulated time.
 * detected -> alert (ConsoleEmail) -> ALERTED -> acknowledge -> assign -> report -> ACTION_REPORTED
 * -> VERIFICATION PENDING. It must stop there: no verification of any kind. Exits non-zero on any
 * failed assertion.
 */
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";

const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
const emails: string[] = [];
const runtime = await createLocalRuntime({ clock, consoleSink: (line) => emails.push(line) });
const base = runtime.server.baseUrl;
const client = new SimulatorClient({
  baseUrl: base,
  deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
  clock,
  initialSeq: 1,
});

async function send(scenario: ScenarioName, count: number): Promise<boolean> {
  let allAccepted = true;
  for (let i = 0; i < count; i++) {
    if ((await client.sendTelemetry(scenarioReadings(scenario, i))).status !== 202)
      allAccepted = false;
    clock.advance(5000);
  }
  return allAccepted;
}

async function api(method: string, path: string, actor: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "X-Demo-Actor-Id": actor,
      ...(body !== undefined && { "Content-Type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as ReturnType<typeof JSON.parse> };
}

const types = () => runtime.bus.history().map((e) => e.event_type as string);

console.log(`runtime listening on ${base} (simulated time, development identity)\n`);
check("heartbeat accepted", (await client.sendHeartbeat("HEALTHY")).status === 200);

console.log("\n-- Stage 1: baseline --");
check("25 known-normal samples accepted over signed HTTP", await send("normal", 25));
check("no case yet", (await runtime.cases.list(ORG)).length === 0);

console.log("\n-- Stage 2: compound deterioration --");
check("compound samples accepted", await send("compound-outdoor-heat", 3));
const cases = await runtime.cases.list(ORG);
check("exactly one case", cases.length === 1);
const caseId = cases[0]?.caseId ?? "";
const riskEvents = await runtime.riskEvents.listByCase(ORG, caseId);
check("exactly one risk event", riskEvents.length === 1);
console.log(`  case ${caseId}   risk event ${riskEvents[0]?.eventId}`);

console.log("\n-- Stage 3: alert workflow --");
check(
  "alert requested, notification sent, event ALERTED (in order)",
  JSON.stringify(
    types().filter((t) => /^(risk\.alert_requested|notification\.|risk\.alerted)/.test(t)),
  ) ===
    JSON.stringify([
      "risk.alert_requested.v1",
      "notification.requested.v1",
      "notification.sent.v1",
      "risk.alerted.v1",
    ]),
);
check("one ConsoleEmail message captured", emails.length === 1);
console.log(
  emails[0]
    ?.split("\n")
    .map((l) => `  | ${l}`)
    .join("\n"),
);
let view = await api("GET", `/api/v1/cases/${caseId}`, MGR);
check(
  "API shows event ALERTED and case OPEN",
  view.body.riskEventState === "ALERTED" && view.body.state === "OPEN",
);

console.log("\n-- Stage 4: acknowledgement by the facility manager --");
const ack = await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, { note: "smoke test" });
check("acknowledged (200)", ack.status === 200);
check(
  "event ACKNOWLEDGED, case still unresolved (OPEN)",
  ack.body.riskEventState === "ACKNOWLEDGED" && ack.body.caseState === "OPEN",
);
check(
  "duplicate acknowledgement rejected (409)",
  (await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {})).status === 409,
);

console.log("\n-- Stage 5: assign an approved action --");
const assign = await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
  actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
  assigneeId: OPERATOR,
});
check("assignment accepted (201)", assign.status === 201);
check("case indicates ACTION_REQUIRED", assign.body.caseState === "ACTION_REQUIRED");
const actionId = assign.body.actionId as string;
const action = await runtime.actions.get(ORG, actionId);
check(
  "action exists as ASSIGNED with library version",
  action?.status === "ASSIGNED" && action.actionLibraryVersion === "cooling-actions.v1",
);
check(
  "an unapproved action is rejected (400)",
  (
    await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
      actionLibraryId: "ACT-RUN-ANYTHING",
      assigneeId: OPERATOR,
    })
  ).status === 400,
);
check(
  "assignee acknowledges the action",
  (await api("POST", `/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR, {}))
    .status === 200,
);

console.log("\n-- Stage 6: report the action --");
const report = await api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
  actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
  actionId,
  notes: "Inspected fan assembly; tightened loose mount.",
});
check("report accepted (200)", report.status === 200);
check(
  "action REPORTED_COMPLETE",
  (await runtime.actions.get(ORG, actionId))?.status === "REPORTED_COMPLETE",
);
check("event ACTION_REPORTED", report.body.riskEventState === "ACTION_REPORTED");
check("case ACTION_REPORTED", report.body.caseState === "ACTION_REPORTED");

console.log("\n-- Stage 7: the system stops at VERIFICATION PENDING --");
view = await api("GET", `/api/v1/cases/${caseId}`, MGR);
check(
  "case is NOT VERIFIED_IMPROVED",
  view.body.state !== "VERIFIED_IMPROVED" && view.body.state === "ACTION_REPORTED",
);
check(
  "no verification id on the case",
  (await runtime.cases.get(ORG, caseId))?.latestVerificationId === undefined,
);
check("no verification.* event emitted", !types().some((t) => t.startsWith("verification")));
check("API says VERIFICATION PENDING", view.body.didItWork.label === "VERIFICATION PENDING");
const page = await (await fetch(`${base}/ui/cases/${caseId}?actor=${MGR}`)).text();
check("UI page says VERIFICATION PENDING", page.includes("VERIFICATION PENDING"));
check(
  "UI/API never render the word VERIFIED",
  !/VERIFIED/i.test(page) && !/VERIFIED/i.test(JSON.stringify(view.body)),
);
console.log(
  `  case state: ${view.body.state}   risk event: ${view.body.riskEventState}   did it work: ${view.body.didItWork.label}`,
);

console.log("\n-- continued deterioration while waiting (S3 gap closed) --");
await send("compound-outdoor-heat", 3);
view = await api("GET", `/api/v1/cases/${caseId}`, MGR);
check(
  "still exactly one case, still ACTION_REPORTED",
  (await runtime.cases.list(ORG)).length === 1 && view.body.state === "ACTION_REPORTED",
);
check(
  "still no verification event or result",
  !types().some((t) => /^(verification|evidence|consent|recurrence)/.test(t)),
);

console.log("\n-- tenancy --");
check(
  "another organization's actor cannot see the case (404)",
  (await api("GET", `/api/v1/cases/${caseId}`, "USR-OTHER-ORG-MGR-001")).status === 404,
);
check("no dead-lettered events", runtime.bus.deadLetters().length === 0);

const audit = (await runtime.audit.listByCase(ORG, caseId)).map((e) => e.action);
console.log(`\n  audit trail: ${[...new Set(audit)].join(", ")}`);
console.log(
  `  S4 event order: ${types()
    .filter((t) => /^(risk\.(alert|acknowledged)|notification|action)/.test(t))
    .join(" > ")}`,
);

await runtime.close();
console.log(failures === 0 ? "\nSMOKE TEST S4 PASSED" : `\nSMOKE TEST S4 FAILED (${failures})`);
// Set exitCode and let the loop drain; process.exit() while sockets close crashes Node on Windows.
process.exitCode = failures === 0 ? 0 : 1;
