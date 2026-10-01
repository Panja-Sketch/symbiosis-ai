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
 * S3 smoke test. Starts the real local runtime (api + worker + in-memory bus) and drives it
 * over real HTTP with the simulator, using the DEFAULT config (2 minute warm-up, 3 persistent
 * evaluations). Time is simulated with a shared ManualClock, so nothing waits in real time.
 * Exits non-zero if any assertion fails.
 */
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
const FAC = SYNTHETIC_DEV_DEVICE.facilityId;

const clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
const runtime = await createLocalRuntime({ clock, consoleSink: () => undefined });
const client = new SimulatorClient({
  baseUrl: runtime.server.baseUrl,
  deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
  clock,
  initialSeq: 1,
});

async function send(scenario: ScenarioName, count: number): Promise<boolean> {
  let allAccepted = true;
  for (let i = 0; i < count; i++) {
    const res = await client.sendTelemetry(scenarioReadings(scenario, i));
    if (res.status !== 202) allAccepted = false;
    clock.advance(5000); // simulated 5 s between samples
  }
  return allAccepted;
}

const histTypes = () => runtime.bus.history().map((e) => e.event_type as string);
const count = (t: string) => histTypes().filter((x) => x === t).length;
const lastOutcome = (signal: string) => {
  const e = runtime.bus
    .history()
    .filter((x) => x.event_type === "risk.observation_evaluated.v1")
    .map((x) => (x.event_type === "risk.observation_evaluated.v1" ? x.payload : undefined))
    .filter((p) => p?.signal === signal)
    .at(-1);
  return e;
};

console.log(`runtime listening on ${runtime.server.baseUrl} (simulated time, default config)\n`);
check("heartbeat accepted", (await client.sendHeartbeat("HEALTHY")).status === 200);

console.log("\n-- 1. baseline: 25 known-normal samples (the default 120 s warm-up) --");
check("all baseline packets accepted over signed HTTP", await send("normal", 25));
const active = await runtime.baselines.listActive(ORG, FAC);
console.log(
  active
    .map(
      (b) =>
        `  ${b.key.assetId}/${b.key.signal}/${b.key.operatingMode}: ${b.status} n=${b.observationCount} mean=${b.mean.toFixed(4)}`,
    )
    .join("\n"),
);
check(
  "baselines for vibration and current are READY",
  ["vibration_rms", "current"].every((s) =>
    active.some((b) => b.key.signal === s && b.status === "READY"),
  ),
);

console.log("\n-- 2. healthy observations --");
await send("normal", 4);
check("healthy samples evaluated NORMAL", lastOutcome("vibration_rms")?.outcome === "NORMAL");
check("no risk case exists", (await runtime.cases.list(ORG)).length === 0);
check("no risk.detected yet", count("risk.detected.v1") === 0);

console.log("\n-- 3. isolated abnormal signals (vibration, then current) --");
await send("isolated-vibration", 6);
check(
  "isolated vibration is WATCH",
  lastOutcome("vibration_rms")?.outcome === "WATCH",
  lastOutcome("vibration_rms")?.reasonCodes.join(","),
);
await send("normal", 1);
await send("isolated-current", 6);
check("isolated current is WATCH", lastOutcome("current")?.outcome === "WATCH");
await send("normal", 1);
check("no hero risk case after isolated anomalies", (await runtime.cases.list(ORG)).length === 0);
check("no risk.detected after isolated anomalies", count("risk.detected.v1") === 0);

console.log("\n-- 4. persistent compound deterioration (vibration + current + outdoor heat) --");
check("compound packets accepted", await send("compound-outdoor-heat", 3));
check(
  "exactly one risk detected",
  count("risk.detected.v1") === 1,
  `risk.detected x${count("risk.detected.v1")}`,
);
const cases = await runtime.cases.list(ORG);
check("exactly one Risk Improvement Case", cases.length === 1);
const theCase = cases[0];
const events = theCase ? await runtime.riskEvents.listByCase(ORG, theCase.caseId) : [];
check("exactly one Risk Event", events.length === 1);
check(
  "case is OPEN with origin DETECTED_HAZARD and its event exists (S4 alerting has moved it to ALERTED)",
  theCase?.state === "OPEN" &&
    theCase.origin.type === "DETECTED_HAZARD" &&
    events[0]?.state === "ALERTED",
);
const detection = runtime.bus
  .history()
  .map((e) => (e.event_type === "risk.detected.v1" ? e.payload : undefined))
  .find((p) => p !== undefined);
console.log(`\n  case id:        ${theCase?.caseId}`);
console.log(`  risk event id:  ${events[0]?.eventId}`);
console.log(`  detection id:   ${detection?.detectionId}`);
console.log(`  severity:       ${theCase?.severity}   assets: ${theCase?.assetIds.join(", ")}`);
console.log(`  baseline snap:  ${theCase?.baselineSnapshotId}`);
console.log(`  reason codes:   ${detection?.reasonCodes.join(", ")}`);
console.log(`  metrics:        ${JSON.stringify(detection?.metrics)}`);

const tail = histTypes();
const lastQa = tail.lastIndexOf("telemetry.quality_assessed.v1");
// S4 appends alerting events after case.created; the S3 chain is the first seven events.
const seq = tail.slice(lastQa, lastQa + 7);
check(
  "event order: quality_assessed -> observation_evaluated -> risk.detected -> case.created",
  seq[0] === "telemetry.quality_assessed.v1" &&
    seq.slice(1, -2).every((t) => t === "risk.observation_evaluated.v1") &&
    seq.at(-2) === "risk.detected.v1" &&
    seq.at(-1) === "case.created.v1",
  seq.join(" > "),
);

console.log("\n-- 5. continued deterioration updates the same case --");
await send("compound-outdoor-heat", 4);
check("still exactly one case", (await runtime.cases.list(ORG)).length === 1);
check(
  "still exactly one risk event",
  (theCase ? (await runtime.riskEvents.listByCase(ORG, theCase.caseId)).length : 0) === 1,
);
check(
  "case.created once, case.updated for the continuation",
  count("case.created.v1") === 1 && count("case.updated.v1") === 4,
  `created=${count("case.created.v1")} updated=${count("case.updated.v1")}`,
);

console.log("\n-- scope --");
check(
  "no verification, evidence, consent or recurrence events (nothing acts on a case in S3)",
  [...new Set(histTypes())].every((t) => !/^(verification|evidence|consent|recurrence)\./.test(t)),
);
check("no dead-lettered events", runtime.bus.deadLetters().length === 0);

await runtime.close();
console.log(failures === 0 ? "\nSMOKE TEST S3 PASSED" : `\nSMOKE TEST S3 FAILED (${failures})`);
// Set exitCode and let the event loop drain; process.exit() while sockets close crashes on Windows.
process.exitCode = failures === 0 ? 0 : 1;
