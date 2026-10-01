import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e !== "node_modules") walk(p);
      } else if (
        p.endsWith(".ts") &&
        !p.endsWith(".test.ts") &&
        !p.endsWith(".fixture.ts") &&
        !p.endsWith("fixtures.ts")
      ) {
        out.push(p);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

const S5_SOURCES = [
  ...sources(join(root, "packages", "verification", "src")),
  ...sources(join(root, "packages", "recurrence", "src")),
  ...sources(join(root, "packages", "intervention-prioritization", "src")),
  join(root, "apps", "worker", "src", "verification-runner.ts"),
];

describe("S5 stays deterministic and local", () => {
  it("covers real files", () => {
    expect(S5_SOURCES.length).toBeGreaterThan(8);
  });

  it("uses no AI, cloud SDK, network, randomness, ambient clock or environment", () => {
    for (const f of S5_SOURCES) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(
        /gemini|vertex|openai|anthropic|\bllm\b|firebase|firestore|pubsub|cloud\s?storage|@google|googleapis/i,
      );
      expect(code, rel(f)).not.toMatch(
        /\b(?:Date\.now|new Date\(\)|process\.env|fetch\(|Math\.random|randomUUID|setTimeout|setInterval)/,
      );
    }
  });

  it("does not implement S6: no evidence package, manifest, hash, consent or sharing", () => {
    for (const f of S5_SOURCES) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(
        /evidence\.package_created|evidence\.shareable|consent\.granted|createHash|sha-?256|manifest|ConsentGateway|evidence\.shared/i,
      );
    }
  });
});

describe("only the verification runner can complete a verification", () => {
  const callers = [
    ...sources(join(root, "packages")),
    ...sources(join(root, "apps")),
    ...sources(join(root, "adapters")),
    ...sources(join(root, "scripts")),
  ].filter((f) => {
    const code = stripComments(readFileSync(f, "utf8"));
    return /\bcompleteVerification\s*\(|\bstartVerification\s*\(|RECORD_VERIFICATION|COMPLETE_VERIFICATION/.test(
      code,
    );
  });

  it("completeVerification / startVerification are used by the runner only (plus the domain that defines them)", () => {
    const allowed = [
      "apps/worker/src/verification-runner.ts",
      "packages/risk-lifecycle/src/index.ts",
      "packages/risk-cases/src/index.ts",
      "packages/recommendations/src/index.ts", // S1 recommendation aggregate, its own state machine
    ];
    expect(callers.map(rel).sort()).toEqual(allowed.sort());
  });

  it("the HTTP layer, operations service and alerting never reference verification commands", () => {
    for (const f of [
      "apps/api/src/app-handler.ts",
      "packages/action-orchestration/src/operations.ts",
      "packages/action-orchestration/src/actions.ts",
      "packages/notifications/src/alerting.ts",
      "packages/escalation/src/index.ts",
    ]) {
      const code = stripComments(readFileSync(join(root, f), "utf8"));
      expect(code, f).not.toMatch(/completeVerification|startVerification|evaluateVerification/);
    }
  });

  it("the runner derives results from the engine, never from action or user input", () => {
    const code = stripComments(
      readFileSync(join(root, "apps/worker/src/verification-runner.ts"), "utf8"),
    );
    expect(code).toMatch(/evaluateVerification\(/);
    // the only literal results it can write directly are the fail-safe INCONCLUSIVE ones
    expect(code).not.toMatch(/result:\s*"(?:VERIFIED|PARTIALLY_VERIFIED|NOT_IMPROVING)"/);
  });
});

describe("thresholds live in versioned config, not in code", () => {
  const policy = JSON.parse(
    readFileSync(join(root, "config/verification-policy/cooling-electrical.v1.json"), "utf8"),
  );

  it("the shipped policy defines every field the spec requires", () => {
    expect(policy).toMatchObject({
      policyId: expect.any(String),
      policyVersion: expect.any(String),
      reference: { source: expect.any(String) },
      postActionWindow: { durationSeconds: expect.any(Number) },
      minObservations: expect.any(Number),
      criteria: { vibration: { role: "REQUIRED" }, current: { role: "REQUIRED" } },
      acceptableMissingness: { maxMissingFraction: expect.any(Number) },
      minTelemetryConfidence: expect.any(Number),
      integrity: { requireAuthenticated: true, requiredDeviceHealth: "HEALTHY" },
      sustained: { seconds: expect.any(Number) },
      recurrenceWatch: { seconds: expect.any(Number) },
    });
    expect(policy.criteria.vibration.abnormalMin).toBeGreaterThan(
      policy.criteria.vibration.targetMax,
    );
  });

  it("verification code holds none of the policy numbers", () => {
    for (const f of sources(join(root, "packages", "verification", "src"))) {
      if (f.endsWith("policy.ts")) continue; // parser: validates, does not default
      const code = stripComments(readFileSync(f, "utf8"));
      for (const n of ["0.9", "0.25", "0.8", "0.2", "3600", "120"]) {
        expect(code, `${rel(f)} ${n}`).not.toMatch(
          new RegExp(`(?<![\\w.])${n.replace(".", "\\.")}(?![\\w.])`),
        );
      }
    }
  });

  it("intervention thresholds are in config and in no source file", () => {
    for (const f of sources(join(root, "packages", "intervention-prioritization", "src"))) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(/recurrenceCount\s*(?:>=|>|===)\s*\d/);
      expect(code, rel(f)).not.toMatch(/SITE_VISIT_RECOMMENDED"\s*[;,)]?\s*$/m);
    }
  });

  it("the UI renders only model-supplied result wording and holds no policy numbers", () => {
    const html = stripComments(readFileSync(join(root, "apps/api/src/html.ts"), "utf8"));
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/VERIFIED|NOT IMPROVING|INCONCLUSIVE|PARTIALLY/i);
  });
});

describe("the S5 product surface", () => {
  it("offers only the specified verification and intervention routes (no insurer evidence API)", () => {
    const text = readFileSync(join(root, "apps/api/src/app-handler.ts"), "utf8");
    expect(text).toMatch(/"verifications"/);
    expect(text).toMatch(/"interventions"/);
    expect(text).not.toMatch(/insurer|evidence-packages|\/evidence\/|consent/i);
  });
});
