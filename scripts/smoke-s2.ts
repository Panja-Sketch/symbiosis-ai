import { SimulatorClient } from "@symbiosis/adapter-simulator";
import { SystemClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { createLocalRuntime } from "./local-runtime";

/**
 * S2 smoke test: starts the real local runtime (api + worker + in-memory bus) on an ephemeral
 * port and drives it over real HTTP with the simulator client. Exits non-zero on any failure.
 */
let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures += 1;
}

const runtime = await createLocalRuntime();
console.log(`runtime listening on ${runtime.server.baseUrl}\n`);

const client = new SimulatorClient({
  baseUrl: runtime.server.baseUrl,
  deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
  clock: new SystemClock(),
});

const heartbeat = await client.sendHeartbeat("HEALTHY");
check("heartbeat accepted", heartbeat.status === 200, `status ${heartbeat.status}`);

const request = client.buildTelemetryRequest();
const accepted = await client.send(request);
check("valid signed packet accepted", accepted.status === 202, `status ${accepted.status}`);
console.log("  response:", JSON.stringify(accepted.body));

const observations = await runtime.observations.list(SYNTHETIC_DEV_DEVICE.organizationId);
console.log("\ncanonical observations:");
for (const o of observations) {
  console.log(
    `  ${o.signal.padEnd(18)} ${String(o.value).padEnd(8)} ${o.unit.padEnd(8)} ` +
      `conf=${o.quality.confidence} stale=${o.quality.stale} oor=${o.quality.outOfRange} ` +
      `healthy=${o.quality.deviceHealthy} auth=${o.quality.authVerified} [${o.sourceType}/${o.sourceAdapter}]`,
  );
}
check("six canonical observations produced", observations.length === 6);

const history = runtime.bus.history();
console.log("\nevent sequence:");
for (const e of history) {
  console.log(
    `  ${e.event_type.padEnd(32)} id=${e.event_id} cause=${e.causation_id ?? "null"} corr=${e.correlation_id}`,
  );
}
const expectedTypes = [
  "telemetry.received.v1",
  "telemetry.authenticated.v1",
  "telemetry.normalized.v1",
  "telemetry.quality_assessed.v1",
];
check(
  "event sequence is exactly received -> authenticated -> normalized -> quality_assessed",
  JSON.stringify(history.map((e) => e.event_type)) === JSON.stringify(expectedTypes),
);
check(
  "causation chain and single correlation ID preserved",
  history[0]?.causation_id === null &&
    history[1]?.causation_id === history[0]?.event_id &&
    history[2]?.causation_id === history[1]?.event_id &&
    history[3]?.causation_id === history[2]?.event_id &&
    new Set(history.map((e) => e.correlation_id)).size === 1,
);
check("no risk events emitted", !history.some((e) => e.event_type.startsWith("risk.")));

console.log("");
const replay = await client.send(request);
check(
  "replayed packet rejected",
  replay.status === 409,
  `status ${replay.status} ${JSON.stringify(replay.body)}`,
);

const fresh = client.buildTelemetryRequest();
const tampered = new TextEncoder().encode(
  new TextDecoder().decode(fresh.body).replace("55.1", "99.9"),
);
const tamperedResult = await client.send({ ...fresh, body: tampered });
check(
  "tampered payload rejected",
  tamperedResult.status === 401,
  `status ${tamperedResult.status} ${JSON.stringify(tamperedResult.body)}`,
);

const after = await runtime.observations.list(SYNTHETIC_DEV_DEVICE.organizationId);
check(
  "rejected requests produced no observations or events",
  after.length === 6 && runtime.bus.history().length === 4,
);

await runtime.close();
console.log(failures === 0 ? "\nSMOKE TEST PASSED" : `\nSMOKE TEST FAILED (${failures})`);
// Set exitCode and let the event loop drain; calling process.exit() while sockets are
// closing triggers a libuv assertion on Windows.
process.exitCode = failures === 0 ? 0 : 1;
