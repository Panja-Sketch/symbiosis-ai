import { Firestore } from "@symbiosis/adapter-gcp";

// TEMPORARY read-only diagnosis; not committed.
const db = new Firestore({ projectId: "symbiosis-ai-2026" });
const snap = await db.collection("observations").where("organizationId", "==", "ORG-SIM-001").get();
const rows = snap.docs
  .map((d) => JSON.parse(String(d.data().json)))
  .filter((o) => o.facilityId === "FAC-SIM-PHX-01")
  .sort((a, b) => a.observedAt.localeCompare(b.observedAt));
console.log("sim observations:", rows.length);
const by: Record<string, number> = {};
for (const o of rows) by[`${o.signal}|conf=${o.quality.confidence}|stale=${o.quality.stale}|healthy=${o.quality.deviceHealthy}`] = (by[`${o.signal}|conf=${o.quality.confidence}|stale=${o.quality.stale}|healthy=${o.quality.deviceHealthy}`] ?? 0) + 1;
console.log(by);
const last = rows.slice(-12).map((o) => `${o.observedAt.slice(11, 19)} ${o.signal} ${o.value} conf=${o.quality.confidence} rcv=${o.receivedAt.slice(11, 19)}`);
console.log(last.join("\n"));
const dev = await db.collection("devices").get();
for (const d of dev.docs) {
  const j = JSON.parse(String(d.data().json));
  console.log(d.id, j.status, j.health, j.lastSeenAt);
}
await db.terminate();
