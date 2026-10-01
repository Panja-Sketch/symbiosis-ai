import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { verifyEvidencePackage } from "@symbiosis/evidence";
import type { EvidencePackage } from "@symbiosis/contracts";
import { createLocalRuntime } from "./local-runtime";
import type { LocalRuntime } from "./local-runtime";

/**
 * S6 smoke test: evidence and consent, end to end over real HTTP with simulated time.
 * The S5 hero flow reaches a completed VERIFIED assessment; then an immutable evidence package
 * with a SHA-256 manifest is created, becomes SHAREABLE (not SHARED), is denied to the insurer
 * until the facility grants scoped consent, is released only within those scopes (never raw
 * telemetry, never another facility), every insurer read is audited, and after revocation reads
 * fail while the package and its hashes stay intact. Exits non-zero on any failed assertion.
 */
let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (ok) passes += 1;
  else failures += 1;
}

const ORG = SYNTHETIC_DEV_DEVICE.organizationId;
const FAC = SYNTHETIC_DEV_DEVICE.facilityId;
const MGR = "USR-FACILITY-MGR-001";
const OPERATOR = "USR-OPERATOR-001";
const ADMIN = "USR-ORG-ADMIN-001";
const INSURER_RE = "USR-RISK-ENGINEER-001";
const OTHER_INSURER = "USR-OTHER-INSURER-RE-001";
const INSPECT = "ACT-COOLING-INSPECT-PRIMARY";

type Json = ReturnType<typeof JSON.parse>;

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

console.log(`runtime listening on ${base} (simulated time, development identity)\n`);
await client.sendHeartbeat("HEALTHY");

console.log("-- 1: the S5 hero flow reaches a completed VERIFIED assessment --");
await send("normal", 25);
await send("compound-outdoor-heat", 3);
const caseId = (await runtime.cases.list(ORG))[0]?.caseId ?? "";
await api("POST", `/api/v1/cases/${caseId}/acknowledge`, MGR, {});
const assign = await api("POST", `/api/v1/cases/${caseId}/assignments`, MGR, {
  actionLibraryId: INSPECT,
  assigneeId: OPERATOR,
});
const actionId = assign.body.actionId as string;
await api("POST", `/api/v1/cases/${caseId}/actions/${actionId}/acknowledge`, OPERATOR, {});
await api("POST", `/api/v1/cases/${caseId}/actions`, OPERATOR, {
  actionLibraryId: INSPECT,
  actionId,
  notes: "Inspected the primary cooling assembly.",
});
await api("POST", "/api/v1/ops/tick", ADMIN, {});
await send("normal", 25);
const done = (await api("POST", "/api/v1/ops/tick", ADMIN, {})).body;
const attempt = (await runtime.verifications.listByCase(ORG, caseId))[0];
check(
  "1. completed assessment is VERIFIED and the case is VERIFIED_IMPROVED",
  done.verification.completed[0]?.result === "VERIFIED" &&
    (await runtime.cases.get(ORG, caseId))?.state === "VERIFIED_IMPROVED",
);
const resultBefore = JSON.stringify(attempt?.assessment);

console.log("\n-- 2-6: immutable evidence package, snapshot, manifest, hash --");
const records = await runtime.evidencePackages.listByCase(ORG, caseId);
const record = records[0];
check("2. exactly one evidence package was created for the verification", records.length === 1);
check(
  "2b. evidence.package_created emitted, correlated to verification.completed",
  (() => {
    const created = runtime.bus
      .history()
      .find((e) => e.event_type === "evidence.package_created.v1");
    const completed = runtime.bus
      .history()
      .find((e) => e.event_type === "verification.completed.v1");
    return (
      created?.causation_id === completed?.event_id &&
      created?.correlation_id === completed?.correlation_id
    );
  })(),
);
const fetched = await api("GET", `/api/v1/evidence/${record?.packageId}`, MGR);
const pkg = fetched.body.package as EvidencePackage;
check(
  "2c. package readable by the insured with its verification result VERIFIED",
  fetched.status === 200 && pkg.payload.verification.result === "VERIFIED",
);
check(
  "3. every evidence reference of the verification resolves to an artifact in the package",
  (attempt?.evidenceReferences ?? []).length > 0 &&
    (attempt?.evidenceReferences ?? []).every((r) =>
      pkg.artifacts.some((a) => a.id === r.id && a.kind === r.kind),
    ),
  `${pkg.artifacts.length} artifacts`,
);
const deviceArtifact = pkg.artifacts.find(
  (a) => a.id === `DEVICE:${SYNTHETIC_DEV_DEVICE.deviceId}`,
);
check(
  "4. device health/auth facts are snapshotted (HEALTHY at verification time)",
  (deviceArtifact?.snapshot as Json | undefined)?.health === "HEALTHY",
);
check(
  "5. SHA-256 manifest covers the payload hash, schema, policy version and artifact hashes",
  /^[0-9a-f]{64}$/.test(pkg.manifestSha256) &&
    /^[0-9a-f]{64}$/.test(pkg.manifest.payloadSha256) &&
    pkg.manifest.packageSchema === "evidence-package.v1" &&
    pkg.manifest.versions.verificationPolicy.version === "1" &&
    pkg.manifest.artifacts.length === pkg.artifacts.length &&
    pkg.manifest.artifacts.every((a) => /^[0-9a-f]{64}$/.test(a.sha256)),
);
check(
  "6. recomputing the hashes proves the package valid (server and independent recomputation)",
  fetched.body.integrity.valid === true && verifyEvidencePackage(pkg).valid,
);
check(
  "synthetic labelling is explicit in the package",
  pkg.payload.source.synthetic === true &&
    pkg.payload.source.dataOrigin === "SYNTHETIC_SIMULATOR" &&
    pkg.payload.source.label.startsWith("SYNTHETIC DATA"),
);

// the live registry changes afterwards: history must not
await client.sendHeartbeat("FAULT");
const live = await runtime.registry.get(SYNTHETIC_DEV_DEVICE.deviceId);
const refetched = (await api("GET", `/api/v1/evidence/${record?.packageId}`, MGR)).body;
check(
  "4b. a later live device-health change does not alter the package or its hash",
  live?.health === "FAULT" &&
    refetched.package.manifestSha256 === pkg.manifestSha256 &&
    refetched.integrity.valid === true &&
    (refetched.package.artifacts.find((a: Json) => a.id === deviceArtifact?.id)?.snapshot as Json)
      .health === "HEALTHY",
);

console.log("\n-- 7: SHAREABLE, not SHARED --");
let cs = await runtime.cases.get(ORG, caseId);
check(
  "7. case is SHAREABLE with latestEvidencePackageId set, and not SHARED",
  cs?.sharingState === "SHAREABLE" && cs.latestEvidencePackageId === record?.packageId,
);
check(
  "7b. evidence.shareable emitted; no evidence.shared / consent events yet",
  types().includes("evidence.shareable.v1") &&
    !types().includes("evidence.shared.v1") &&
    !types().includes("consent.granted.v1"),
);

console.log("\n-- 8: the insurer is denied before consent --");
const before = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER_RE);
check(
  "8. insurer read before consent is DENIED (403 ACCESS_DENIED)",
  before.status === 403 &&
    before.body.error.code === "ACCESS_DENIED" &&
    !("package" in before.body),
);
check(
  "8b. insurer sees no sites before consent",
  (await api("GET", "/insurance/v1/sites", INSURER_RE)).body.sites.length === 0,
);

console.log("\n-- 9-10: scoped consent, then exactly those fields --");
const granted = await api("POST", "/api/v1/sharing-agreements", MGR, {
  recipientOrganizationId: "ORG-INS-001",
  facilityIds: [FAC],
  scopes: [
    "RECOMMENDATION",
    "BEFORE_AFTER_METRICS",
    "VERIFICATION_RESULT",
    "VERIFICATION_CONFIDENCE",
    "EVIDENCE_ARTIFACTS",
  ],
});
check(
  "9. the facility manager grants scoped consent (201)",
  granted.status === 201 && granted.body.agreement.organizationId === ORG,
);
const agreementId = granted.body.agreement.agreementId as string;
cs = await runtime.cases.get(ORG, caseId);
check(
  "9b. only now is the case SHARED; consent.granted and evidence.shared emitted",
  cs?.sharingState === "SHARED" &&
    types().includes("consent.granted.v1") &&
    types().includes("evidence.shared.v1"),
);
const read = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER_RE);
const keys = Object.keys(read.body).sort();
check(
  "10. insurer reads the allowed evidence (200) with exactly the granted sections",
  read.status === 200 &&
    read.body.verification?.result === "VERIFIED" &&
    read.body.confidence !== undefined &&
    read.body.beforeAfter !== undefined &&
    read.body.evidencePackage?.integrity === "VERIFIED" &&
    read.body.recommendation !== undefined &&
    read.body.actionSummary === undefined &&
    read.body.eventSummary === undefined &&
    read.body.recurrence === undefined &&
    read.body.rawTelemetry === undefined,
  keys.join(","),
);
const leak = /Inspected the primary|USR-|"snapshot"|"firmwareVersion"|"observationId"|KEY-SIM/.exec(
  JSON.stringify(read.body),
);
check(
  "10b. the insurer view is labelled synthetic and exposes no notes, actors, devices or raw values",
  read.body.source?.synthetic === true && leak === null,
  leak === null ? "" : `leaked ${leak[0]}`,
);
const view = (await api("GET", "/api/v1/cases/" + caseId, MGR)).body;
check(
  "10c. package existence and sharing did not change the verification result",
  JSON.stringify((await runtime.verifications.listByCase(ORG, caseId))[0]?.assessment) ===
    resultBefore && view.didItWork.status === "VERIFIED_IMPROVED",
);

console.log("\n-- 11-12: raw telemetry and other facilities stay denied --");
const raw = await api(
  "GET",
  `/insurance/v1/cases/${caseId}/evidence?include=raw_telemetry`,
  INSURER_RE,
);
check(
  "11. raw telemetry without the explicit RAW_TELEMETRY scope is DENIED",
  raw.status === 403 && raw.body.error.reason === "SCOPE_NOT_GRANTED",
);
const other = await api("GET", "/insurance/v1/sites/FAC-OTHER-001/cases", INSURER_RE);
check(
  "12. another facility is DENIED",
  other.status === 403 && other.body.error.code === "ACCESS_DENIED",
);
const wrongRecipient = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, OTHER_INSURER);
check("12b. a different insurer organization is DENIED", wrongRecipient.status === 403);
const noRole = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, MGR);
check("12c. an insured-side actor cannot use the insurance API", noRole.status === 403);

console.log("\n-- 13: insurer reads are audited --");
const trail = await runtime.audit.list(ORG);
const reads = trail.filter((e) => e.action === "INSURER_EVIDENCE_READ");
const denials = trail.filter((e) => e.action === "INSURER_ACCESS_DENIED");
check(
  "13. successful reads and denials are in the append-only audit log with actor, agreement and scopes",
  reads.length >= 1 &&
    denials.length >= 1 &&
    reads.every(
      (e) => e.actorId === INSURER_RE && e.actorType === "USER" && e.correlationId.length > 0,
    ) &&
    reads.some(
      (e) =>
        Array.isArray(e.details?.agreementIds) &&
        (e.details?.agreementIds as string[]).includes(agreementId),
    ),
  `${reads.length} reads, ${denials.length} denials`,
);

console.log("\n-- 14-18: revocation --");
clock.advance(1000);
const revoked = await api("POST", `/api/v1/sharing-agreements/${agreementId}/revoke`, MGR, {
  reason: "smoke",
});
check(
  "14. the facility manager revokes consent; historical agreement preserved",
  revoked.status === 200 &&
    revoked.body.status === "REVOKED" &&
    revoked.body.agreement.revokedBy === MGR &&
    revoked.body.agreement.scopes.length === 5 &&
    types().includes("consent.revoked.v1"),
);
const after = await api("GET", `/insurance/v1/cases/${caseId}/evidence`, INSURER_RE);
check(
  "15. the same insurer read is now DENIED immediately (AGREEMENT_REVOKED)",
  after.status === 403 && after.body.error.reason === "AGREEMENT_REVOKED",
);
check(
  "15b. every insurer endpoint denies or returns nothing after revocation",
  (await api("GET", "/insurance/v1/sites", INSURER_RE)).body.sites.length === 0 &&
    (await api("GET", `/insurance/v1/cases/${caseId}`, INSURER_RE)).status === 403 &&
    (await api("GET", `/insurance/v1/sites/${FAC}/cases`, INSURER_RE)).status === 403 &&
    (await api("GET", "/insurance/v1/recommendations", INSURER_RE)).body.recommendations.length ===
      0,
);
check(
  "16. the underlying evidence package still exists",
  (await runtime.evidencePackages.get(ORG, record?.packageId ?? "")) !== undefined &&
    (await runtime.evidenceStore.get(record?.objectKey ?? "")) !== undefined,
);
const final = (await api("GET", `/api/v1/evidence/${record?.packageId}`, MGR)).body;
check(
  "17. the evidence hash still verifies, unchanged",
  final.integrity.valid === true && final.package.manifestSha256 === pkg.manifestSha256,
);
cs = await runtime.cases.get(ORG, caseId);
check("18. the case sharing state is REVOKED", cs?.sharingState === "REVOKED");
check(
  "the case is still VERIFIED_IMPROVED (sharing never touches the physical-risk state)",
  cs?.state === "VERIFIED_IMPROVED",
);
check("no dead-lettered events", runtime.bus.deadLetters().length === 0);
console.log(
  `  S6 event order: ${types()
    .filter((t) => /^(verification\.completed|evidence|consent)/.test(t))
    .join(" > ")}`,
);
await runtime.close();

console.log(`\n${passes} PASS, ${failures} FAIL`);
console.log(failures === 0 ? "SMOKE TEST S6 PASSED" : `SMOKE TEST S6 FAILED (${failures})`);
// Set exitCode and let the loop drain; process.exit() while sockets close crashes Node on Windows.
process.exitCode = failures === 0 ? 0 : 1;
