// S9 mutation checks: deliberately break an invariant, prove the test suite notices, restore.
// Usage: node scripts/mutation-s9.mjs   (run from the repo root with a clean working tree)
// Each mutation edits one source file, runs only the tests that should catch it, expects failures,
// then restores the file with `git checkout`. Exits non-zero if any mutation SURVIVES.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (status !== "") {
  console.error("working tree must be clean before mutation checks");
  process.exit(2);
}

const mutations = [
  {
    id: "M1 gcp mode falls back to memory",
    file: "packages/runtime/src/config.ts",
    from: `if (onCloudRun && requested !== "gcp") {`,
    to: `if (false && onCloudRun && requested !== "gcp") {`,
    tests: ["packages/runtime/src/config.test.ts"],
  },
  {
    id: "M2 Firebase token not verified",
    file: "adapters/gcp/src/auth/firebase.ts",
    from: `uid = (await this.deps.verify(token)).uid;`,
    to: `uid = "uid-mgr"; void this.deps.verify;`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M3 organization taken from the request",
    file: "adapters/gcp/src/auth/firebase.ts",
    from: `return await this.deps.directory.get(actorId);`,
    to: `const a = await this.deps.directory.get(actorId); const o = request.headers["x-organization-id"]; return a === undefined || o === undefined ? a : { ...a, organizationId: o };`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M4 Firestore tenant filter removed",
    file: "adapters/gcp/src/firestore/repositories.ts",
    from: `    return getDoc<RiskImprovementCase>(this.ctx, C.cases, tenantDocId(organizationId, caseId));`,
    to: `    return getDoc<RiskImprovementCase>(this.ctx, C.cases, tenantDocId("ORG-A", caseId));`,
    tests: ["tests/contract/repositories.contract.test.ts"],
    emulator: true,
  },
  {
    id: "M5 evidence object overwrite allowed",
    file: "adapters/gcp/src/storage/evidence.ts",
    from: `if (!created) return false;`,
    to: `void created;`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M6 Pub/Sub duplicate processed twice",
    file: "adapters/gcp/src/pubsub/bus.ts",
    from: `if (await deps.inbox.isProcessed(event.event_id)) {`,
    to: `if (false && (await deps.inbox.isProcessed(event.event_id))) {`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M7 secret value logged",
    file: "adapters/gcp/src/logger.ts",
    from: `    if (name === "key" || SENSITIVE_NAME.test(name)) {`,
    to: `    if (false) {`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M8 production AI token accepted as a static env secret",
    file: "packages/runtime/src/config.ts",
    from: `if ((env.VERTEX_ACCESS_TOKEN ?? "") !== "") {`,
    to: `if (false) {`,
    tests: ["packages/runtime/src/config.test.ts"],
  },
  {
    id: "M9 storage failure treated as successful evidence creation",
    file: "adapters/gcp/src/storage/evidence.ts",
    from: `const created = await this.objects.createIfAbsent(key, content);`,
    to: `const created = await this.objects.createIfAbsent(key, content).catch(() => true);`,
    tests: ["adapters/gcp/src/gcp.test.ts"],
  },
  {
    id: "M10 insurer request bypasses consent",
    file: "packages/consent/src/access.ts",
    from: `  if (sameParties.length === 0) {
    return { allowed: false, reason: "NO_AGREEMENT_FOR_TARGET", internalReason: "NO_AGREEMENT" };
  }`,
    to: `  if (sameParties.length === 0) {
    return { allowed: true, scopes: new Set(["RECOMMENDATION"]) } as never;
  }`,
    tests: ["packages/consent/src"],
  },
];

let survivors = 0;
for (const m of mutations) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`${m.id}: PATTERN NOT FOUND (update the script)`);
    survivors += 1;
    continue;
  }
  writeFileSync(
    m.file,
    original.replace(m.from, () => m.to),
  );
  const run = spawnSync("pnpm", ["vitest", "run", ...m.tests], {
    encoding: "utf8",
    shell: true,
    env: { ...process.env, ...(m.emulator ? { SYMBIOSIS_REQUIRE_EMULATOR: "1" } : {}) },
  });
  execFileSync("git", ["checkout", "--", m.file]);
  const out = `${run.stdout}${run.stderr}`;
  const failed = /Tests\s+(?:\d+ passed \| )?(\d+) failed/.exec(out)?.[1];
  const caught = run.status !== 0 && failed !== undefined;
  console.log(`${m.id}: ${caught ? `DETECTED (${failed} failed)` : "SURVIVED"}`);
  if (!caught) survivors += 1;
}
console.log(
  survivors === 0 ? "all mutations detected, all files restored" : `${survivors} SURVIVED`,
);
process.exitCode = survivors === 0 ? 0 : 1;
