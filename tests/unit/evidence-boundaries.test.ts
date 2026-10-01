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
      } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".fixture.ts")) {
        out.push(p);
      }
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const read = (p: string) => stripComments(readFileSync(p, "utf8"));
const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

const S6_PACKAGES = [
  ...sources(join(root, "packages", "evidence", "src")),
  ...sources(join(root, "packages", "consent", "src")),
];
const S6_SOURCES = [...S6_PACKAGES, join(root, "apps", "api", "src", "insurance-handler.ts")];

describe("S6 stays deterministic, local and free of cloud SDKs and AI", () => {
  it("covers real files", () => {
    expect(S6_PACKAGES.length).toBeGreaterThan(8);
  });

  it("uses no AI, cloud SDK, network, randomness, ambient clock or environment", () => {
    for (const f of S6_SOURCES) {
      const code = read(f);
      expect(code, rel(f)).not.toMatch(
        /gemini|vertex|openai|anthropic|\bllm\b|firebase|firestore|pubsub|cloud\s?storage|@google|googleapis|secret\s?manager/i,
      );
      expect(code, rel(f)).not.toMatch(
        /\b(?:Date\.now|new Date\(\)|process\.env|fetch\(|Math\.random|randomUUID|setTimeout|setInterval)/,
      );
    }
  });

  it("declares only workspace dependencies", () => {
    for (const name of ["evidence", "consent"]) {
      const json = JSON.parse(
        readFileSync(join(root, "packages", name, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
      };
      for (const d of Object.keys(json.dependencies ?? {})) {
        expect(d.startsWith("@symbiosis/"), `${name} -> ${d}`).toBe(true);
      }
    }
    const rootPkg = readFileSync(join(root, "package.json"), "utf8");
    expect(rootPkg).not.toMatch(/@google-cloud|firebase|"next"|@google\/genai|vertexai/i);
  });

  it("hashes only in the evidence hash module", () => {
    const users = S6_SOURCES.filter((f) => /createHash|node:crypto/.test(read(f))).map(rel);
    expect(users).toEqual(["packages/evidence/src/hash.ts"]);
  });
});

describe("the evidence builder only documents: it cannot change a verification or a risk state", () => {
  it("the evidence package writes nothing but packages, objects, one audit entry, one event and the case link", () => {
    for (const f of sources(join(root, "packages", "evidence", "src"))) {
      const code = read(f);
      expect(code, rel(f)).not.toMatch(
        /verifications\.save|riskEvents\.save|actions\.save|baselines\.save|observations\.insertIfAbsent/,
      );
      expect(code, rel(f)).not.toMatch(
        /applyCaseCommand|completeVerification|startVerification|evaluateVerification/,
      );
      expect(code, rel(f)).not.toMatch(/registry\./); // device facts come from the frozen snapshot only
    }
    const service = read(join(root, "packages", "evidence", "src", "service.ts"));
    expect(service.match(/cases\.save\(/g)).toHaveLength(1);
    expect(service).toMatch(/applyCaseDocumentation\(/);
  });

  it("the consent package never touches verifications, risk events or lifecycle commands", () => {
    for (const f of sources(join(root, "packages", "consent", "src"))) {
      const code = read(f);
      expect(code, rel(f)).not.toMatch(
        /verifications\.|riskEvents\.|applyCaseCommand|completeVerification|\.registry/,
      );
    }
  });

  it("evidence is built only by the evidence service's own subscription (no consent, API or UI code builds packages)", () => {
    const users = [...sources(join(root, "packages")), ...sources(join(root, "apps"))]
      .filter((f) => /createForVerification\(/.test(read(f)))
      .map(rel)
      .sort();
    expect(users).toEqual(["packages/evidence/src/service.ts"]);
  });
});

describe("every insurer read is consent filtered", () => {
  const gateway = read(join(root, "packages", "consent", "src", "gateway.ts"));

  it("each gateway method checks the role and authorizes against the stored agreements", () => {
    for (const method of [
      "sites",
      "casesForSite",
      "caseView",
      "evidence",
      "recommendations",
      "interventions",
    ]) {
      const start = gateway.indexOf(`    async ${method}(actor`);
      expect(start, method).toBeGreaterThan(-1);
      const next = gateway.indexOf("\n    async ", start + 10);
      const body = gateway.slice(start, next === -1 ? undefined : next);
      expect(body, method).toMatch(/requireRole\(actor\)/);
      expect(body, method).toMatch(/evaluateAccess\(|authorizeCase\(|activeSites\(/);
      if (method !== "sites") expect(body, method).toMatch(/evaluateAccess\(|authorizeCase\(/);
    }
  });

  it("the recipient organization always comes from the authenticated actor", () => {
    expect(gateway).toMatch(/listForRecipient\(actor\.organizationId\)/);
    expect(
      gateway.match(/recipientOrganizationId: actor\.organizationId/g)?.length,
    ).toBeGreaterThanOrEqual(4);
    expect(gateway).not.toMatch(/recipientOrganizationId: (?!actor\.organizationId)/);
  });

  it("the insurance HTTP handler reaches data only through the gateway", () => {
    const handler = read(join(root, "apps", "api", "src", "insurance-handler.ts"));
    expect(handler).not.toMatch(
      /@symbiosis\/repositories|@symbiosis\/evidence|\.cases\.|observations/,
    );
    expect(handler).toMatch(/deps\.gateway\.sites/);
    expect(handler).toMatch(/deps\.gateway\.casesForSite/);
    expect(handler).toMatch(/deps\.gateway\.caseView/);
    expect(handler).toMatch(/deps\.gateway\.evidence/);
    expect(handler).toMatch(/deps\.gateway\.recommendations/);
    expect(handler).toMatch(/deps\.gateway\.interventions/);
    // read-only, exactly the six locked routes
    expect(handler).toMatch(/!== "GET"/);
    expect(handler.match(/route\.length === \d+/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("the audit entry is written before anything is released, and a failed audit releases nothing", () => {
    expect(gateway).toMatch(/AUDIT_FAILURE/);
    const evidenceBody = gateway.slice(gateway.indexOf("    async evidence(actor"));
    expect(evidenceBody.indexOf("allowedAudit(")).toBeGreaterThan(-1);
    expect(evidenceBody.indexOf("allowedAudit(")).toBeLessThan(
      evidenceBody.lastIndexOf("return ok(view)"),
    );
  });
});

describe("raw telemetry is not exposed by default", () => {
  it("only the explicit raw projection lists observation values, and only the gateway's raw branch calls it", () => {
    const projection = read(join(root, "packages", "consent", "src", "projection.ts"));
    expect(projection.match(/\.snapshot/g)).toHaveLength(1);
    expect(projection).not.toMatch(
      /@symbiosis\/repositories|observations\.(?:get|list)|ObservationRepository/,
    );
    const callers = S6_SOURCES.filter(
      (f) => /projectRawTelemetry\(/.test(read(f)) && !f.endsWith("projection.ts"),
    ).map(rel);
    expect(callers).toEqual(["packages/consent/src/gateway.ts"]);
    const gateway = read(join(root, "packages", "consent", "src", "gateway.ts"));
    expect(gateway).toMatch(/options\.includeRawTelemetry === true/);
    expect(gateway).toMatch(/"RAW_TELEMETRY"/);
  });

  it("the standard grant and the UI default never include RAW_TELEMETRY", () => {
    const contracts = readFileSync(
      join(root, "packages", "contracts", "src", "consent.ts"),
      "utf8",
    );
    expect(contracts).toMatch(/filter\(\s*\(s\) => s !== "RAW_TELEMETRY"/);
    const html = read(join(root, "apps", "api", "src", "html.ts"));
    expect(html).toMatch(/value="RAW_TELEMETRY">/); // present but never `checked`
    expect(html).not.toMatch(/value="RAW_TELEMETRY" checked/);
    const handler = read(join(root, "apps", "api", "src", "app-handler.ts"));
    expect(handler).toMatch(/standardScopes: EVIDENCE_CONSENT_SCOPES/);
  });

  it("an agreement is never created from a request-supplied organization", () => {
    const handler = read(join(root, "apps", "api", "src", "app-handler.ts"));
    const grant = handler.slice(
      handler.indexOf("createAgreement(actor,"),
      handler.indexOf("createAgreement(actor,") + 400,
    );
    expect(grant).not.toMatch(/organizationId: body/);
    const sharing = read(join(root, "packages", "consent", "src", "sharing.ts"));
    expect(sharing).toMatch(
      /organizationId: actor\.organizationId, \/\/ never taken from the request|organizationId: actor\.organizationId/,
    );
  });
});

describe("S6 backend packages stay free of UI, AI and cloud code (S7 added only apps/web)", () => {
  it("adds no Gemini, Firebase, Pub/Sub or Cloud Storage code, and no React in packages or the API", () => {
    for (const f of [...sources(join(root, "packages")), ...sources(join(root, "apps", "api"))]) {
      if (rel(f).includes("/ai-explanation/")) continue;
      const code = read(f);
      expect(code, rel(f)).not.toMatch(
        /from\s+["'](?:@google-cloud\/|@google\/|firebase|firebase-admin|googleapis|next|react)/,
      );
    }
  });

  it("emits only the five S6 event types and no UI-specific events", () => {
    const events = readFileSync(join(root, "packages", "contracts", "src", "events.ts"), "utf8");
    const s6 = events.match(/"(?:evidence|consent)\.[a-z_]+\.v1"/g) ?? [];
    expect([...new Set(s6)].sort()).toEqual([
      '"consent.granted.v1"',
      '"consent.revoked.v1"',
      '"evidence.package_created.v1"',
      '"evidence.shareable.v1"',
      '"evidence.shared.v1"',
    ]);
    expect(events).not.toMatch(/"(?:ui|workspace|portfolio|trust)[._]/i);
  });
});
