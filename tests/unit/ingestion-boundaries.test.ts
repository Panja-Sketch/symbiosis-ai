import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");

function sources(group: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) {
        if (e !== "node_modules") walk(p);
      } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        out.push(p);
      }
    }
  };
  const base = join(root, group);
  for (const pkg of readdirSync(base)) {
    const src = join(base, pkg, "src");
    if (existsSync(src)) walk(src);
  }
  return out;
}

const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

describe("hardware independence (spec principle 7)", () => {
  const HARDWARE_MODELS = /esp32|sht41|mpu6050|ina219/i;

  it("canonical, domain, ingestion and app sources never name hardware models", () => {
    const files = [...sources("packages"), ...sources("apps")];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(HARDWARE_MODELS);
    }
  });

  it("no adapter names a hardware model either (the physical prototype left the product, D-085)", () => {
    for (const f of sources("adapters")) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(/esp32|sht41|mpu6050|ina219/i);
    }
  });

  it("the canonical signal vocabulary contains no hardware model names", () => {
    const text = readFileSync(join(root, "packages/contracts/src/canonical.ts"), "utf8");
    const block = text.slice(text.indexOf("CANONICAL_SIGNALS"), text.indexOf("as const;"));
    expect(block).not.toMatch(/esp32|sht41|mpu6050|ina219/i);
  });
});

describe("S4 stays within scope", () => {
  const all = [...sources("packages"), ...sources("apps"), ...sources("adapters")];

  it("defines the S5 and S6 events and no sharing.* or UI-specific events (S7+)", () => {
    const text = readFileSync(join(root, "packages/contracts/src/events.ts"), "utf8");
    const union = text.slice(
      text.indexOf("export type PlatformEvent ="),
      text.indexOf("export type PlatformEventType"),
    );
    // 19 S2-S4 events + verification.started/completed, recurrence.detected, case.reopened,
    // intervention.recommendation_updated (S5) + evidence.package_created, evidence.shareable,
    // consent.granted, consent.revoked, evidence.shared (S6) + telemetry.source_authenticated (S10, D-088)
    expect(union.match(/^\s*\| /gm)).toHaveLength(30);
    expect(text).toMatch(/"verification\.started\.v1"/);
    expect(text).toMatch(/"verification\.completed\.v1"/);
    expect(text).toMatch(/"recurrence\.detected\.v1"/);
    expect(text).toMatch(/"evidence\.package_created\.v1"/);
    expect(text).toMatch(/"consent\.granted\.v1"/);
    expect(text).not.toMatch(/"sharing[._]/i);
    expect(text).not.toMatch(/"(ui|workspace|portfolio)[._]/i);
    expect(text).not.toMatch(/"risk\.(verif|recurr)/i);
  });

  it("has no alerting, notification, workflow or verification-evaluation code in S3 packages", () => {
    const s3 = ["baselines", "risk-detection"].flatMap((p) =>
      sources("packages").filter((f) => rel(f).startsWith(`packages/${p}/`)),
    );
    expect(s3.length).toBeGreaterThan(0);
    for (const f of s3) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(
        /notif|acknowledg|escalat|mitigat|postAction|verificationPolicy|gemini|vertex|openai/i,
      );
    }
  });

  it("introduces no cloud SDK dependency in any manifest", () => {
    const manifests = [join(root, "package.json")];
    for (const g of ["apps", "packages", "adapters"]) {
      for (const d of readdirSync(join(root, g))) manifests.push(join(root, g, d, "package.json"));
    }
    for (const m of manifests) {
      const json = JSON.parse(readFileSync(m, "utf8")) as Record<string, Record<string, string>>;
      const names = Object.keys({ ...json.dependencies, ...json.devDependencies });
      // Workspace links (including @symbiosis/adapter-gcp) are not SDKs; the cloud SDKs themselves
      // may be declared only by adapters/gcp (S9, D-069).
      if (rel(m) === "adapters/gcp/package.json") continue;
      // The browser sign-in client (S9) is the one third-party identity dependency of the web app.
      if (rel(m) === "apps/web/package.json") names.splice(names.indexOf("firebase") >>> 0, 1);
      for (const n of names.filter((x) => !x.startsWith("@symbiosis/"))) {
        expect(n, rel(m)).not.toMatch(
          /google|firebase|gcp|@aws|azure|pubsub|firestore|gemini|vertex/i,
        );
      }
    }
  });

  it("source files do not import cloud SDKs", () => {
    for (const f of all) {
      // Cloud SDK imports are confined to adapters/gcp (S9) and the web login client (S9).
      if (rel(f).startsWith("adapters/gcp/") || rel(f).startsWith("apps/web/src/lib/firebase"))
        continue;
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(
        /from\s+["'](?:@google|@google-cloud|firebase|googleapis)/,
      );
    }
  });
});
