import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "..", "apps", "web", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const source = files(WEB).filter((f) => /\.(ts|tsx)$/.test(f));
const production = source.filter((f) => !/\.test\.tsx?$/.test(f));
const text = (f: string) => readFileSync(f, "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const rel = (f: string) => f.replace(WEB, "").replace(/\\/g, "/");

describe("S7 web boundary: presentation only", () => {
  it("imports no workspace domain package, repository or backend script", () => {
    for (const f of production) {
      const imports = [...text(f).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] as string);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(/^@symbiosis\//);
        expect(i, `${f} imports ${i}`).not.toMatch(/(^|\/)(packages|scripts|adapters)\//);
        expect(i, `${f} imports ${i}`).not.toMatch(/repositor/i);
      }
    }
  });

  it("reaches the backend only through lib/api.ts over HTTP", () => {
    const fetchers = production.filter((f) => /\bfetch\(/.test(strip(text(f))));
    expect(fetchers.map(rel)).toEqual(["/lib/api.ts"]);
  });

  it("only the two documented API prefixes are used", () => {
    for (const f of production) {
      for (const m of strip(text(f)).matchAll(/["'`](\/(?:api|insurance)\/[^"'`]*)/g)) {
        expect(m[1], f).toMatch(/^\/(api\/v1|insurance\/v1)\//);
      }
    }
  });

  it("holds no detection, verification, recurrence, consent or intervention rule", () => {
    const forbidden = [
      /z[_-]?score\s*[<>]=?/i,
      /percent_deviation\s*[<>]=?/i,
      /persist(ence|ed)?Count\s*[<>]=?/,
      /recurrenceWindow|recurrence_window/i,
      /passFraction|partialMaxAbnormalFraction|targetMax/,
      /minObservations|maxMissingFraction/,
      /evaluateAccess|agreementStatus|isAgreementActive/,
      /prioriti[sz]e|INTERVENTION_POLICY|escalationCondition/i,
      /Date\.now\(\)|new Date\(\)/,
    ];
    for (const f of production) {
      const s = strip(text(f));
      for (const r of forbidden) expect(s, `${f} matches ${r}`).not.toMatch(r);
    }
  });

  it("has no AI client, cloud or production-identity code (the API owns explanations; S9 owns cloud)", () => {
    for (const f of production) {
      const s = strip(text(f));
      expect(s, f).not.toMatch(
        /@google|genai|vertexai|aiplatform|generativelanguage|firebase|firestore|pubsub|openai|anthropic/i,
      );
      expect(s, f).not.toMatch(/fetch\([^)]*gemini/i);
    }
  });

  it("never asks the insurer API for raw telemetry", () => {
    for (const f of production) expect(strip(text(f)), f).not.toMatch(/include=raw_telemetry/);
  });

  it("insurer pages use the insurer API only and facility pages the application API only", () => {
    for (const f of production.filter((x) => /app[\\/]risk-evidence/.test(x))) {
      expect(text(f), f).not.toMatch(/loadOperations|loadCase\(/);
    }
    for (const f of production.filter((x) => /app[\\/]operations/.test(x))) {
      expect(text(f), f).not.toMatch(/loadRiskEvidence|loadInsurerCase/);
    }
  });

  it("the case page only forwards intent: there is no command that decides a verification", () => {
    const commands = strip(text(join(WEB, "lib", "commands.ts")));
    expect(commands).not.toMatch(/verif|recurr|intervention/i);
  });
});
