import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * S10 architectural rule (D-086): the simulator produces SOURCE DATA and equipment state only. The
 * deterministic pipeline decides what that means. These tests make a shortcut impossible to add by
 * accident: the simulation package has no import path to cases, risk events, actions, verification,
 * intervention, evidence or sharing, and the HTTP layer that exposes it never writes them.
 */
const root = join(import.meta.dirname, "..", "..");
const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

function files(dir: string, test = false): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && /\.test\.tsx?$/.test(p) === test) out.push(p);
    }
  };
  walk(dir);
  return out;
}
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const text = (f: string) => strip(readFileSync(f, "utf8"));

const SIM = files(join(root, "packages", "simulation", "src"));

describe("the simulation package is a source of data, not a decision maker", () => {
  it("exists and has source files", () => {
    expect(SIM.length).toBeGreaterThanOrEqual(6);
  });

  it("imports only the packages a data producer needs", () => {
    const allowed = new Set([
      "@symbiosis/audit",
      "@symbiosis/clock",
      "@symbiosis/contracts",
      "@symbiosis/device-registry",
      "@symbiosis/edge-security",
      "@symbiosis/event-bus",
      "@symbiosis/repositories",
      "@symbiosis/tenancy",
      "node:crypto",
    ]);
    for (const f of SIM) {
      for (const m of text(f).matchAll(/from\s+["']([^"']+)["']/g)) {
        const spec = m[1] as string;
        if (spec.startsWith(".")) continue;
        expect(allowed.has(spec), `${rel(f)} imports ${spec}`).toBe(true);
      }
    }
  });

  it("reaches repositories only through the generic tenant document store", () => {
    const allowedNames = new Set([
      "TenantDocumentStore",
      "DocIndex",
      "ListFilter",
      "TenantCollection",
      "UpdateResult",
    ]);
    for (const f of SIM) {
      for (const m of text(f).matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']@symbiosis\/repositories["']/g,
      )) {
        for (const name of (m[1] as string)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)) {
          expect(allowedNames.has(name), `${rel(f)} imports ${name} from repositories`).toBe(true);
        }
      }
    }
  });

  it("has no vocabulary for cases, verification outcomes, evidence, sharing or interventions", () => {
    const forbidden =
      /RiskImprovementCase|RiskEvent\b|CaseRepository|VerificationAttempt|VerificationResult|VERIFIED|NOT_IMPROVING|PARTIALLY_VERIFIED|INCONCLUSIVE|EvidencePackage|SharingAgreement|InterventionRecommendation|openCaseFromDetection|applyCaseCommand|applyRiskEventCommand|completeVerification|startVerification|createOperations|\.recurrence/;
    for (const f of SIM) expect(text(f), rel(f)).not.toMatch(forbidden);
  });

  it("cannot reach the platform except through the signed edge request it is given", () => {
    for (const f of SIM) {
      const code = text(f);
      expect(code, rel(f)).not.toMatch(
        /\bfetch\(|normalizeTelemetry|assessObservation|evaluateSample|bus\.publish|insertIfAbsent/,
      );
    }
    // the only outward call is the injected `submit` of already-signed bytes
    expect(text(join(root, "packages", "simulation", "src", "engine.ts"))).toMatch(
      /deps\.submit\(/,
    );
  });

  it("the physical state has no field that could carry a business outcome", () => {
    const state = text(join(root, "packages", "simulation", "src", "state.ts"));
    const block = state.slice(
      state.indexOf("export type PhysicalValues"),
      state.indexOf("export type NumericField"),
    );
    expect(block).not.toMatch(/severity|case|verif|result|alert|evidence|risk|recurr/i);
  });

  it("the scenario library describes the physical world only", () => {
    const cfg = JSON.parse(
      readFileSync(join(root, "config", "simulation", "scenarios.v1.json"), "utf8"),
    ) as {
      scenarios: Record<string, unknown>[];
    };
    const allowedKeys = [
      "id",
      "label",
      "summary",
      "values",
      "rampSeconds",
      "weatherMode",
      "world",
      "expectation",
    ];
    for (const s of cfg.scenarios) {
      expect(Object.keys(s).every((k) => allowedKeys.includes(k))).toBe(true);
      for (const k of Object.keys(s.values as object)) {
        expect(k).not.toMatch(/severity|case|verif|result|alert|evidence|risk|recurr/i);
      }
    }
  });
});

describe("the HTTP layer that exposes the simulation never writes a case, verification or evidence", () => {
  const api = [
    ...files(join(root, "apps", "api", "src")).filter((f) => /simulation-[^/\\]*\.ts$/.test(f)),
  ];

  it("has simulation handlers to check", () => {
    expect(api.length).toBeGreaterThanOrEqual(1);
  });

  it("calls no domain command and saves into no domain repository", () => {
    const forbidden =
      /\b(cases|riskEvents|actions|verifications|interventions|evidencePackages|agreements|shares|alerts|baselines|detectionStates)\.(save|insertIfAbsent|create|put|update|delete|saveSnapshot|appendAudit)\b|applyCaseCommand|applyRiskEventCommand|startVerification|completeVerification|createOperations|reopenCaseForRecurrence|openCaseFromDetection|createEvidenceService|createVerificationRunner/;
    for (const f of api) expect(text(f), rel(f)).not.toMatch(forbidden);
  });
});

describe("the web workspace only displays and forwards", () => {
  const web = files(join(root, "apps", "web", "src")).filter((f) => /simulation/i.test(rel(f)));

  it("has simulation screens to check", () => {
    expect(web.length).toBeGreaterThanOrEqual(1);
  });

  it("decides nothing: no rule, no outcome, no clock", () => {
    for (const f of web) {
      const code = text(f);
      expect(code, rel(f)).not.toMatch(
        /Date\.now\(\)|new Date\(\)|setVerification|VERIFIED_IMPROVED\s*=|result\s*=\s*["']VERIFIED|z[_-]?score\s*[<>]=?|percent_deviation\s*[<>]=?/,
      );
    }
  });
});
