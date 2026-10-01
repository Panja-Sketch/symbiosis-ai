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

  it("only the esp32 adapter may name the ESP32", () => {
    const adapterFiles = sources("adapters").filter((f) => !rel(f).startsWith("adapters/esp32/"));
    for (const f of adapterFiles) {
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

  it("defines no verification, evidence, consent, recurrence or intervention events (S5+)", () => {
    const text = readFileSync(join(root, "packages/contracts/src/events.ts"), "utf8");
    const union = text.slice(
      text.indexOf("export type PlatformEvent ="),
      text.indexOf("export type PlatformEventType"),
    );
    expect(union.match(/^\s*\| /gm)).toHaveLength(19);
    expect(text).not.toMatch(
      /"(verification|evidence|consent|recurrence|intervention|sharing)[._]/i,
    );
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
      for (const n of names) {
        expect(n, rel(m)).not.toMatch(
          /google|firebase|gcp|@aws|azure|pubsub|firestore|gemini|vertex/i,
        );
      }
    }
  });

  it("source files do not import cloud SDKs", () => {
    for (const f of all) {
      expect(readFileSync(f, "utf8"), rel(f)).not.toMatch(
        /from\s+["'](?:@google|@google-cloud|firebase|googleapis)/,
      );
    }
  });
});
