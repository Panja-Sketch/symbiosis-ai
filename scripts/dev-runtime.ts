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
  "risk.alert_requested.v1",
  "notification.sent.v1",
  "notification.failed.v1",
  "risk.alerted.v1",
  "risk.acknowledged.v1",
  "risk.escalated.v1",
  "action.assigned.v1",
  "action.reported.v1",
  "verification.started.v1",
  "verification.completed.v1",
  "recurrence.detected.v1",
  "case.reopened.v1",
  "intervention.recommendation_updated.v1",
  "evidence.package_created.v1",
  "evidence.shareable.v1",
  "consent.granted.v1",
  "consent.revoked.v1",
  "evidence.shared.v1",
] as const) {
  runtime.bus.subscribe(type, (event) => {
    console.log(`[bus] ${event.event_type} ${event.event_id} corr=${event.correlation_id}`);
  });
}

console.log(`[api+worker] listening on ${runtime.server.baseUrl} (in-memory, synthetic device)`);

// Scheduler stand-in: the same tick a Cloud Scheduler job will call later (S9).
const tickMs = Number(process.env.OPS_TICK_INTERVAL_MS ?? 10_000);
const timer = setInterval(() => {
  void runtime.tick().then((r) => {
    const v = r.verification;
    if (
      r.escalated.length > 0 ||
      r.retried > 0 ||
      v.started.length > 0 ||
      v.completed.length > 0 ||
      v.failures.length > 0
    ) {
      console.log("[tick]", JSON.stringify(r));
    }
  });
}, tickMs);
console.log(`[api+worker] ops tick every ${tickMs} ms; try /ui/cases?actor=USR-FACILITY-MGR-001`);

const shutdown = () => {
  clearInterval(timer);
  void runtime.close();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
