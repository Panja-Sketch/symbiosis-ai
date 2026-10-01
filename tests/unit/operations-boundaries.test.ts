import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

const S4_PACKAGES = [
  "notifications",
  "escalation",
  "audit",
  "tenancy",
  "authz",
  "action-orchestration",
];
const S4_APP_FILES = [
  "apps/api/src/app-handler.ts",
  "apps/api/src/html.ts",
  "apps/worker/src/risk-pipeline.ts",
];

function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".fixture.ts"))
        out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

const s4Files = [
  ...S4_PACKAGES.flatMap((p) => sources(join(root, "packages", p, "src"))),
  ...S4_APP_FILES.map((f) => join(root, f)),
];

describe("S4 stays within its boundaries", () => {
  it("covers real files", () => {
    expect(s4Files.length).toBeGreaterThan(12);
  });

  it("imports and uses no Gemini, Vertex AI, Firebase, Firestore, Pub/Sub, Cloud Storage or Cloud Scheduler", () => {
    for (const f of s4Files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(
        /gemini|vertex|firebase|firestore|pubsub|pub\/sub|cloud\s?storage|cloud\s?scheduler|@google|googleapis|nodemailer|smtp(?!_)/i,
      );
    }
  });

  it("the human-command path cannot produce a verification: no verification commands, events or verified states", () => {
    // S5: the read model and HTTP pages may display results, but nothing a person can invoke
    // (operations, actions, alerting, escalation, audit, authz, tenancy) may start, complete or
    // record a verification, emit verification events, or name a verified state.
    const commandSide = s4Files.filter(
      (f) => !/(view\.ts|html\.ts|risk-pipeline\.ts|app-handler\.ts)$/.test(f),
    );
    expect(commandSide.length).toBeGreaterThan(10);
    for (const f of commandSide) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(
        /validateVerificationAssessment|START_VERIFICATION|RECORD_VERIFICATION|COMPLETE_VERIFICATION|completeVerification|startVerification|verification\.(started|completed)|VERIFIED_IMPROVED|"VERIFIED"|"VERIFYING"/,
      );
    }
  });

  it("has no autonomous equipment-control vocabulary", () => {
    for (const f of s4Files) {
      const code = stripComments(readFileSync(f, "utf8"));
      expect(code, rel(f)).not.toMatch(
        /setpoint|actuat|relay|mosfet|setFanSpeed|startFan|stopFan|controlEquipment\s*[:=]\s*true/i,
      );
    }
  });

  it("the approved action library is RECOMMEND_ONLY with stable action IDs", () => {
    const lib = JSON.parse(
      readFileSync(join(root, "config", "action-library", "cooling-actions.v1.json"), "utf8"),
    ) as { actions: { actionLibraryId: string; controlsEquipment: boolean }[] };
    expect(lib.actions.length).toBeGreaterThanOrEqual(3);
    for (const a of lib.actions) {
      expect(a.controlsEquipment).toBe(false);
      expect(a.actionLibraryId).toMatch(/^ACT-[A-Z0-9-]+$/);
    }
  });

  it("escalation timeouts live in versioned config, not in source", () => {
    const config = JSON.parse(
      readFileSync(join(root, "config", "escalation", "escalation.v1.json"), "utf8"),
    ) as { acknowledgementDeadlineSeconds: Record<string, number> };
    expect(config.acknowledgementDeadlineSeconds.MODERATE).toBe(900);
    for (const f of sources(join(root, "packages", "escalation", "src"))) {
      expect(stripComments(readFileSync(f, "utf8")), rel(f)).not.toMatch(/\b(900|300|3600)\b/);
    }
  });

  it("the HTTP layer holds no lifecycle rules: it never applies state-machine commands directly", () => {
    const text = stripComments(readFileSync(join(root, "apps/api/src/app-handler.ts"), "utf8"));
    expect(text).not.toMatch(/applyRiskEventCommand|applyCaseCommand|applyActionCommand/);
  });

  it("the minimal UI is read-only server-rendered HTML without scripts or the word VERIFIED", () => {
    const html = readFileSync(join(root, "apps/api/src/html.ts"), "utf8");
    expect(html).not.toMatch(/<script/i);
    expect(stripComments(html)).not.toMatch(/VERIFIED/i);
  });

  it("the development identity is declared as such and never reads an organization from the request", () => {
    const text = readFileSync(join(root, "apps/api/src/app-handler.ts"), "utf8");
    expect(text).toMatch(/DEVELOPMENT-ONLY IDENTITY/);
    expect(stripComments(text)).not.toMatch(/organizationId\s*[:=]\s*(b|body|query)/);
  });
});
