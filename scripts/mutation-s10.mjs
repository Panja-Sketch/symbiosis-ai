// S10 mutation checks: deliberately break an invariant, prove the test suite notices, restore.
// Usage: node scripts/mutation-s10.mjs [M<n>]   (run from the repo root with a clean working tree)
// Each mutation edits one source file, runs only the tests that should catch it, expects failures,
// then restores the file with `git checkout`. Exits non-zero if any mutation SURVIVES.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
if (status !== "") {
  console.error("working tree must be clean before mutation checks");
  process.exit(2);
}

const SIM_TESTS = ["tests/unit/simulation-boundaries.test.ts"];

const mutations = [
  {
    id: "M1 simulator directly creates a case",
    file: "packages/simulation/src/engine.ts",
    from: `export class SimulationEngine`,
    to: `import type { CaseRepository } from "@symbiosis/repositories";\nexport const leakedCases: CaseRepository | undefined = undefined;\nexport class SimulationEngine`,
    tests: SIM_TESTS,
  },
  {
    id: "M2 simulator directly sets a verification result",
    file: "packages/simulation/src/engine.ts",
    from: `export class SimulationEngine`,
    to: `export const leakedVerification = { result: "VERIFIED" as const };\nexport class SimulationEngine`,
    tests: SIM_TESTS,
  },
  {
    id: "M3 weather fabricated after a provider failure",
    file: "adapters/weather/src/service.ts",
    from: `        return finish("UNAVAILABLE", { failure: { code: result.code, message: result.message } });
      }
      return finish("SIMULATED", { reading: result.reading });`,
    to: `        return finish("LIVE", { reading: { temperatureC: 45, observedAt: new Date(deps.clock.nowMs()).toISOString() } as never });
      }
      return finish("SIMULATED", { reading: result.reading });`,
    tests: ["adapters/weather/src/weather.test.ts"],
  },
  {
    id: "M4 threshold changed without versioning",
    file: "config/rules/cooling-electrical.v1.json",
    from: `    "vibrationZ": 2,`,
    to: `    "vibrationZ": 3,`,
    tests: ["packages/risk-detection/src", "tests/integration/detection.test.ts"],
  },
  {
    id: "M5 adapter bypasses canonical bounds validation",
    file: "packages/normalization/src/source-mapping.ts",
    from: `if (f.bounds !== undefined && (value < f.bounds.min || value > f.bounds.max)) {`,
    to: `if (false && f.bounds !== undefined && (value < f.bounds.min || value > f.bounds.max)) {`,
    tests: ["packages/normalization/src/source-mapping.test.ts"],
  },
  {
    id: "M6 cross-tenant simulation control allowed",
    file: "apps/api/src/simulation-handler.ts",
    from: `      actor.organizationId !== facility.organizationId ||`,
    to: `      false ||`,
    tests: ["tests/security/simulation-authz.test.ts"],
  },
  {
    id: "M7 duplicate email after event redelivery",
    file: "packages/notifications/src/alerting.ts",
    from: `    if (!(await deps.deliveries.reserve(pending))) return alert;`,
    to: `    await deps.deliveries.reserve(pending);`,
    tests: ["packages/notifications/src/s10-notifications.test.ts"],
  },
  {
    id: "M8 ineffective action treated as verified",
    file: "packages/verification/src/engine.ts",
    from: `    result = "NOT_IMPROVING";
    headline = "TRUSTED_EVIDENCE_SHOWS_NO_IMPROVEMENT";`,
    to: `    result = "VERIFIED";
    headline = "TRUSTED_EVIDENCE_SHOWS_NO_IMPROVEMENT";`,
    tests: ["packages/verification/src", "tests/integration/simulation.test.ts"],
  },
  {
    id: "M9 NOT_IMPROVING fails to generate the follow-up",
    file: "packages/notifications/src/followup.ts",
    from: `  NOT_IMPROVING: "VERIFICATION_NOT_IMPROVING",
  PARTIALLY_VERIFIED`,
    to: `  PARTIALLY_VERIFIED`,
    tests: [
      "packages/notifications/src/s10-notifications.test.ts",
      "tests/integration/simulation.test.ts",
    ],
  },
  {
    id: "M10 recurrence creates a duplicate case",
    file: "apps/worker/src/risk-pipeline.ts",
    from: `    if (decision.kind === "REOPEN") {`,
    to: `    if (false && decision.kind === "REOPEN") {`,
    tests: ["tests/integration/simulation.test.ts", "tests/integration/verification.test.ts"],
  },
  {
    id: "M11 insurer sees unconsented evidence",
    file: "packages/consent/src/access.ts",
    from: `  if (!request.anyOfScopes.some((s) => granted.includes(s))) {`,
    to: `  if (false && !request.anyOfScopes.some((s) => granted.includes(s))) {`,
    tests: ["packages/consent/src", "tests/integration/simulation-scenarios.test.ts"],
  },
  {
    id: "M12 simulated evidence represented as real-building evidence",
    file: "packages/evidence/src/builder.ts",
    from: `  } else if (simulated && external.length === 0) {`,
    to: `  } else if (false && simulated && external.length === 0) {`,
    tests: ["packages/evidence/src", "tests/integration/simulation.test.ts"],
  },
  {
    id: "M13 sim-api proxy forwards any route",
    file: "apps/web/src/app/sim-api/[...path]/route.ts",
    from: `  if (!ROUTES.some((r) => r.method === method && r.pattern.test(joined))) {`,
    to: `  if (false && !ROUTES.some((r) => r.method === method && r.pattern.test(joined))) {`,
    tests: ["tests/security/sim-proxy.test.ts"],
  },
  {
    id: "M14 reset ignores the typed confirmation",
    file: "packages/simulation/src/control.ts",
    from: `confirm !== "RESET"`,
    to: `false`,
    tests: [
      "packages/simulation/src/simulation.test.ts",
      "tests/security/simulation-authz.test.ts",
    ],
  },
];

const only = process.argv[2]; // optional: run one mutation, e.g. `node scripts/mutation-s10.mjs M7`
let survivors = 0;
for (const m of mutations.filter((x) => only === undefined || x.id.startsWith(`${only} `))) {
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
