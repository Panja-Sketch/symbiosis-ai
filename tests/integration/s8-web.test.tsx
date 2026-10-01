import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeGemini, GeminiExplanationProvider } from "@symbiosis/ai-explanation";
import type { FakeGeminiMode } from "@symbiosis/ai-explanation";
import { CaseDetail } from "../../apps/web/src/components/CaseDetail";
import {
  ExplanationLoading,
  ExplanationPanel,
} from "../../apps/web/src/components/ExplanationPanel";
import { InsurerCaseDetail } from "../../apps/web/src/components/InsurerCaseDetail";
import { buildSession, orgNamesFrom, peopleFrom } from "../../apps/web/src/lib/identity";
import {
  loadCase,
  loadDirectory,
  loadExplanation,
  loadInsurerCase,
  loadInsurerExplanation,
  loadMe,
} from "../../apps/web/src/lib/loaders";
import { MGR, RE, closeAll, makeWorld } from "./s6-world";
import type { World } from "./s6-world";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined, usePathname: () => "/" }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

afterEach(async () => {
  await closeAll();
});

function provider(mode: FakeGeminiMode = "ok") {
  return new GeminiExplanationProvider(
    {
      projectId: "p",
      location: "us-central1",
      model: "gemini-test",
      temperature: 0.1,
      maxOutputTokens: 1000,
      timeoutMs: 400,
    },
    async () => "t",
    new FakeGemini(mode).fetch,
  );
}

async function setup(w: World) {
  process.env.SYMBIOSIS_API_URL = w.runtime.server.baseUrl;
  const dir = await loadDirectory();
  if (!dir.ok) throw new Error("directory");
  const me = await loadMe(MGR);
  if (!me.ok) throw new Error("me");
  return {
    directory: dir.value,
    session: buildSession(me.value, dir.value.organizations),
    people: peopleFrom(dir.value),
    orgNames: orgNamesFrom(dir.value),
  };
}

async function facilityPage(w: World, id: string) {
  const x = await setup(w);
  const data = await loadCase(MGR, id);
  const exp = await loadExplanation(MGR, id);
  if (!data.ok) throw new Error("case");
  return renderToStaticMarkup(
    <CaseDetail
      data={data.value}
      session={x.session}
      people={x.people}
      orgNames={x.orgNames}
      assignees={[]}
      insurers={[]}
      explanationSlot={<ExplanationPanel result={exp} audience="FACILITY" />}
    />,
  );
}

describe("S8 facility explanation UI", () => {
  it("keeps the deterministic sections and shows system facts separately from the explanation", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    const html = await facilityPage(w, id);
    // deterministic page untouched
    expect(html).toContain('data-did-it-work="VERIFIED_IMPROVED"');
    expect(html).toContain("Hash check passed");
    // the explanation sits after "Did it work?" and before "Is it staying fixed?"
    expect(html.indexOf('id="did-it-work"')).toBeLessThan(html.indexOf('id="explanation"'));
    expect(html.indexOf('id="explanation"')).toBeLessThan(html.indexOf('id="staying-fixed"'));
    // separate blocks, with the authoritative one first
    expect(html.indexOf('data-testid="authoritative-facts"')).toBeLessThan(
      html.indexOf('data-testid="explanation-text"'),
    );
    expect(html).toContain("Authoritative system facts (deterministic)");
    const facts = html.slice(
      html.indexOf('data-testid="authoritative-facts"'),
      html.indexOf('data-testid="explanation-text"'),
    );
    expect(facts).toContain("Verified improved");
    expect(facts).toContain("Remote Monitoring");
    // template is not presented as AI
    expect(html).toContain('data-explanation="template"');
    expect(html).toContain("No AI model was used");
    expect(html).not.toContain("AI-generated explanation based on verified system data");
  });

  it("labels a validated Gemini answer as AI-generated, with model, and never as a fact", async () => {
    const w = await makeWorld({ explanationProvider: provider("ok") });
    const id = await w.verified();
    const html = await facilityPage(w, id);
    expect(html).toContain('data-explanation="ai"');
    expect(html).toContain("AI-generated explanation based on verified system data");
    expect(html).toContain("gemini (gemini-test)");
    const factsBlock = html.slice(
      html.indexOf('data-testid="authoritative-facts"'),
      html.indexOf('data-testid="explanation-text"'),
    );
    expect(factsBlock).not.toContain("AI-generated");
    expect(factsBlock).not.toContain("In plain terms");
    // the AI prose repeats the status; it does not replace the deterministic label
    expect(html).toContain("In plain terms:");
    expect(html).toContain('data-did-it-work="VERIFIED_IMPROVED"');
  });

  it("shows an honest template fallback when AI fails, and the page still renders fully", async () => {
    for (const [mode, text] of [
      ["quota", "the AI service quota was reached"],
      ["malformed-json", "the AI answer was not in the expected format"],
      ["claims-resolved", "did not match the verified facts, so it was discarded"],
      ["unavailable", "the AI service is unavailable"],
    ] as const) {
      const w = await makeWorld({ explanationProvider: provider(mode) });
      const id = await w.verified();
      const html = await facilityPage(w, id);
      expect(html, mode).toContain('data-explanation="fallback"');
      expect(html, mode).toContain(text);
      expect(html, mode).toContain("no AI model was used");
      expect(html, mode).not.toContain("AI-generated explanation based on verified system data");
      expect(html, mode).toContain('id="timeline"');
      await closeAll();
    }
  });

  it("an unavailable explanation is a quiet notice, not an error page", async () => {
    const html = renderToStaticMarkup(
      <ExplanationPanel
        result={{ ok: false, status: 0, code: "API_UNREACHABLE", message: "down" }}
        audience="FACILITY"
      />,
    );
    expect(html).toContain('data-explanation="unavailable"');
    expect(html).toContain("not available right now");
    expect(html).toContain("system facts above are unchanged");
    expect(html).not.toMatch(/down|API_UNREACHABLE|Error/);
    expect(renderToStaticMarkup(<ExplanationLoading />)).toContain(
      "system facts on this page are already final",
    );
  });

  it("shows only template text that matches every real verification result", async () => {
    const outcomes: [string, string, (w: World) => Promise<void>][] = [
      ["PARTIALLY_VERIFIED", "Partially verified", async (w) => w.send("partial-improvement", 25)],
      ["NOT_IMPROVING", "Not improving", async (w) => w.send("compound-outdoor-heat", 25)],
      ["INCONCLUSIVE", "Inconclusive", async (w) => w.clock.advance(200_000)],
    ];
    for (const [status, label, feed] of outcomes) {
      const w = await makeWorld();
      const id = await w.detect();
      await w.reportAction(id);
      await w.runtime.tick();
      await feed(w);
      await w.runtime.tick();
      const html = await facilityPage(w, id);
      expect(html).toContain(`data-did-it-work="${status}"`);
      const exp = html.slice(html.indexOf('id="explanation"'), html.indexOf('id="staying-fixed"'));
      expect(exp).toContain(label);
      expect(exp).not.toMatch(/(risk|problem|issue) (is|was|has been) (now )?(resolved|fixed)/i);
      await closeAll();
    }
  });
});

describe("S8 insurer explanation UI", () => {
  it("appears only where the insurer is authorized, built from the projection", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    process.env.SYMBIOSIS_API_URL = w.runtime.server.baseUrl;
    // before consent: no case view, no explanation
    expect((await loadInsurerCase(RE, id)).ok).toBe(false);
    expect((await loadInsurerExplanation(RE, id)).ok).toBe(false);

    await w.grant(MGR, { scopes: ["RECOMMENDATION", "VERIFICATION_RESULT", "EVIDENCE_ARTIFACTS"] });
    const data = await loadInsurerCase(RE, id);
    const exp = await loadInsurerExplanation(RE, id);
    if (!data.ok) throw new Error("case");
    const html = renderToStaticMarkup(
      <InsurerCaseDetail
        data={data.value}
        explanationSlot={<ExplanationPanel result={exp} audience="INSURER" />}
      />,
    );
    expect(html).toContain("based only on what the customer shared");
    expect(html).toContain("Authoritative system facts (deterministic)");
    expect(html).toContain("Verified improved");
    expect(html).toContain('data-not-shared="BEFORE_AFTER_METRICS"');
    expect(html).not.toMatch(/Inspected the primary|operator note/);
    expect(html).toContain("not shared with the insurer");
  });

  it("revocation removes the explanation immediately", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    process.env.SYMBIOSIS_API_URL = w.runtime.server.baseUrl;
    const grant = await w.grant(MGR);
    expect((await loadInsurerExplanation(RE, id)).ok).toBe(true);
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${grant.body.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    const after = await loadInsurerExplanation(RE, id);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe("ACCESS_DENIED");
    expect(renderToStaticMarkup(<ExplanationPanel result={after} audience="INSURER" />)).toContain(
      "not available right now",
    );
  });
});
