import { createLocalRuntime } from "./local-runtime";

/** Local api + worker process (in-memory bus, synthetic dev device). Started by `pnpm dev`. */
const port = Number(process.env.EDGE_PORT ?? 8787);

const runtime = await createLocalRuntime({
  port,
  log: (entry) => console.log(`[api] ${entry.level} ${entry.message}`, entry.fields ?? ""),
});

for (const type of [
  "telemetry.received.v1",
  "telemetry.authenticated.v1",
  "telemetry.normalized.v1",
  "telemetry.quality_assessed.v1",
  "risk.detected.v1",
  "case.created.v1",
  "case.updated.v1",
] as const) {
  runtime.bus.subscribe(type, (event) => {
    console.log(`[bus] ${event.event_type} ${event.event_id} corr=${event.correlation_id}`);
  });
}

console.log(`[api+worker] listening on ${runtime.server.baseUrl} (in-memory, synthetic device)`);

const shutdown = () => void runtime.close();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
