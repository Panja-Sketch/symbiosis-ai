import { SystemClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { SCENARIOS, SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";

/**
 * Local simulator CLI. Sends a heartbeat then signed normal telemetry to the edge API at a
 * fixed interval, through the same HTTP endpoints future hardware uses.
 * Env (all optional): EDGE_BASE_URL, SIMULATOR_INTERVAL_MS, SIMULATOR_DEVICE_ID,
 * SIMULATOR_KEY_ID, SIMULATOR_DEVICE_KEY_HEX (defaults to the public synthetic dev key),
 * SIMULATOR_SCENARIO (one of the scenarios in @symbiosis/adapter-simulator; default "normal").
 */
const baseUrl = process.env.EDGE_BASE_URL ?? "http://127.0.0.1:8787";
const intervalMs = Number(process.env.SIMULATOR_INTERVAL_MS ?? 5000);

const scenario = (process.env.SIMULATOR_SCENARIO ?? "normal") as ScenarioName;
if (!SCENARIOS.includes(scenario)) {
  console.error(`[simulator] unknown scenario "${scenario}"; use one of: ${SCENARIOS.join(", ")}`);
  process.exit(1);
}
let step = 0;

const client = new SimulatorClient({
  baseUrl,
  deviceId: process.env.SIMULATOR_DEVICE_ID ?? SYNTHETIC_DEV_DEVICE.deviceId,
  keyId: process.env.SIMULATOR_KEY_ID ?? SYNTHETIC_DEV_DEVICE.activeKeyId,
  key: deviceKeyFromHex(process.env.SIMULATOR_DEVICE_KEY_HEX || SYNTHETIC_DEV_KEY_HEX),
  clock: new SystemClock(),
});

async function tick(): Promise<void> {
  try {
    const hb = await client.sendHeartbeat("HEALTHY");
    const tel = await client.sendTelemetry(scenarioReadings(scenario, step++));
    console.log(`[simulator] heartbeat=${hb.status} telemetry=${tel.status}`);
  } catch (error) {
    console.error(`[simulator] cannot reach ${baseUrl}: ${(error as Error).message}`);
  }
}

console.log(`[simulator] scenario=${scenario} sending to ${baseUrl} every ${intervalMs} ms`);
void tick();
setInterval(() => void tick(), intervalMs);
