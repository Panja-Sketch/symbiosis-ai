import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME as apiName, RESOLVED_CONTRACTS_PHASE } from "../../apps/api/src/index";

const root = join(import.meta.dirname, "..", "..");

const EXPECTED = {
  apps: ["web", "api", "worker", "simulator"],
  packages: [
    "contracts",
    "authz",
    "tenancy",
    "device-registry",
    "edge-security",
    "normalization",
    "data-quality",
    "baselines",
    "risk-detection",
    "recommendations",
    "risk-cases",
    "risk-lifecycle",
    "action-orchestration",
    "escalation",
    "intervention-prioritization",
    "verification",
    "recurrence",
    "evidence",
    "consent",
    "audit",
    "notifications",
    "ai-explanation",
    "loss-model",
    "portfolio",
    "repositories",
    "runtime",
    "simulation",
    "event-bus",
    "clock",
  ],
  // S9 (D-069) adds adapters/gcp (cloud adapters) and packages/runtime (composition + entrypoints).
  adapters: ["simulator", "weather", "email", "gcp"],
} as const;

describe("workspace structure (PROJECT_SPEC §44)", () => {
  for (const [group, names] of Object.entries(EXPECTED)) {
    it(`${group}/ contains exactly the specified members`, () => {
      const actual = readdirSync(join(root, group), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      expect(actual).toEqual([...names].sort());
    });

    it(`every ${group}/ member is a private workspace package with a source entry`, () => {
      for (const name of names) {
        const dir = join(root, group, name);
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name: string;
          private: boolean;
        };
        expect(pkg.private).toBe(true);
        expect(pkg.name.startsWith("@symbiosis/")).toBe(true);
        // apps/web is a Next.js app (S7): its entry is the App Router root layout.
        const entry =
          group === "apps" && name === "web"
            ? join("src", "app", "layout.tsx")
            : join("src", "index.ts");
        expect(existsSync(join(dir, entry))).toBe(true);
      }
    });
  }
});

describe("workspace dependency resolution", () => {
  it("apps/api resolves @symbiosis/contracts via workspace:*", () => {
    expect(RESOLVED_CONTRACTS_PHASE).toBe("S0");
    expect(apiName).toBe("@symbiosis/api");
  });
});
