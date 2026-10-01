import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const GROUPS = ["apps", "packages", "adapters"] as const;

type Pkg = { dir: string; name: string; deps: string[] };

function loadWorkspace(): Pkg[] {
  const out: Pkg[] = [];
  for (const g of GROUPS) {
    for (const entry of readdirSync(join(root, g), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, g, entry.name);
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = Object.keys({ ...json.dependencies, ...json.devDependencies }).filter((d) =>
        d.startsWith("@symbiosis/"),
      );
      out.push({ dir, name: json.name, deps });
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const src = join(dir, "src");
  if (!existsSync(src)) return [];
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(src);
  return files;
}

describe("workspace dependency graph", () => {
  const pkgs = loadWorkspace();
  const byName = new Map(pkgs.map((p) => [p.name, p]));

  it("only depends on workspace packages that exist", () => {
    for (const p of pkgs)
      for (const d of p.deps) expect(byName.has(d), `${p.name} -> ${d}`).toBe(true);
  });

  it("has no dependency cycles", () => {
    const state = new Map<string, "visiting" | "done">();
    const visit = (name: string, path: string[]) => {
      if (state.get(name) === "done") return;
      if (state.get(name) === "visiting") {
        throw new Error(`cycle: ${[...path, name].join(" -> ")}`);
      }
      state.set(name, "visiting");
      for (const d of byName.get(name)?.deps ?? []) visit(d, [...path, name]);
      state.set(name, "done");
    };
    for (const p of pkgs) expect(() => visit(p.name, [])).not.toThrow();
  });

  it("keeps contracts at the bottom of the graph (no workspace dependencies)", () => {
    expect(byName.get("@symbiosis/contracts")?.deps).toEqual([]);
  });
});

describe("S1 domain packages are pure", () => {
  const DOMAIN = [
    "contracts",
    "verification",
    "recommendations",
    "risk-cases",
    "risk-lifecycle",
    "action-orchestration",
  ];
  const FORBIDDEN_IMPORT =
    /from\s+["'](?:@google-cloud\/|@google\/|firebase|firebase-admin|googleapis|@firebase\/|node:(?:http|https|net|fs|child_process)|express|fastify)/;
  const FORBIDDEN_RUNTIME = /\b(?:Date\.now|new Date\(\)|process\.env|fetch\(|Math\.random)/;
  const AI = /gemini|vertex|openai|anthropic|llm/i;

  for (const name of DOMAIN) {
    it(`${name}: no cloud SDK imports, ambient clock/env/network access, or AI coupling`, () => {
      const dir = join(root, "packages", name);
      for (const file of sourceFiles(dir).filter((f) => !f.endsWith(".test.ts"))) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(FORBIDDEN_IMPORT);
        expect(text, file).not.toMatch(FORBIDDEN_RUNTIME);
        expect(text, file).not.toMatch(AI);
      }
    });
  }

  it("package manifests declare no third-party runtime dependencies", () => {
    for (const name of DOMAIN) {
      const json = JSON.parse(
        readFileSync(join(root, "packages", name, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const d of Object.keys(json.dependencies ?? {})) {
        expect(d.startsWith("@symbiosis/"), `${name} -> ${d}`).toBe(true);
      }
    }
  });
});
