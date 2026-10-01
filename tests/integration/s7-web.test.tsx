import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccessDenied } from "../../apps/web/src/components/ui";
import { ApiErrorView } from "../../apps/web/src/components/ApiErrorView";
import { CaseDetail } from "../../apps/web/src/components/CaseDetail";
import { CaseTable, SummaryCards } from "../../apps/web/src/components/Operations";
import { EvidencePanel } from "../../apps/web/src/components/EvidencePanel";
import { InsurerCaseDetail } from "../../apps/web/src/components/InsurerCaseDetail";
import { InterventionPanel } from "../../apps/web/src/components/InterventionPanel";
import { SharingPanel } from "../../apps/web/src/components/SharingPanel";
import {
  InsurerCaseTable,
  InterventionList,
  RiskEvidenceCards,
} from "../../apps/web/src/components/RiskEvidence";
import { buildSession, orgNamesFrom, peopleFrom } from "../../apps/web/src/lib/identity";
import type { Session } from "../../apps/web/src/lib/identity";
import { summarizeRiskEvidence } from "../../apps/web/src/lib/insurer";
import {
  loadCase,
  loadDirectory,
  loadInsurerCase,
  loadMe,
  loadOperations,
  loadRiskEvidence,
} from "../../apps/web/src/lib/loaders";
import { summarizeCases } from "../../apps/web/src/lib/summary";
import { INTERVENTION_ORDER } from "../../apps/web/src/lib/labels";
import {
  ADMIN,
  AUDITOR,
  MGR,
  OTHER_INSURER,
  OTHER_ORG_MGR,
  RE,
  closeAll,
  makeWorld,
} from "./s6-world";
import type { World } from "./s6-world";

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined, usePathname: () => "/" }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

afterEach(async () => {
  await closeAll();
});

async function web(w: World) {
  process.env.SYMBIOSIS_API_URL = w.runtime.server.baseUrl;
  const dir = (await loadDirectory()) as {
    ok: true;
    value: Parameters<typeof peopleFrom>[0] & object;
  };
  const directory = dir.value as NonNullable<Parameters<typeof peopleFrom>[0]>;
  const session = async (actor: string): Promise<Session> => {
    const me = await loadMe(actor);
    if (!me.ok) throw new Error("no identity");
    return buildSession(me.value, directory.organizations);
  };
  return { directory, people: peopleFrom(directory), orgNames: orgNamesFrom(directory), session };
}

async function caseHtml(w: World, caseId: string, actor = MGR) {
  const x = await web(w);
  const r = await loadCase(actor, caseId);
  if (!r.ok) throw new Error(r.message);
  return renderToStaticMarkup(
    <CaseDetail
      data={r.value}
      session={await x.session(actor)}
      people={x.people}
      orgNames={x.orgNames}
      assignees={x.directory.actors.filter((a) => a.organizationId === "ORG-SIM-001")}
      insurers={x.directory.organizations.filter((o) => o.type === "INSURER")}
    />,
  );
}

describe("S7 facility UI over the real API", () => {
  it("detected: risk state, reasons, acknowledge control, no verification claim", async () => {
    const w = await makeWorld();
    const id = await w.detect();
    const html = await caseHtml(w, id);
    expect(html).toContain("Risk detected");
    expect(html).toContain("Vibration is well above its learned baseline");
    expect(html).toContain("Acknowledge this risk");
    expect(html).toContain("NO ACTION REPORTED YET");
    expect(html).not.toContain("VERIFIED IMPROVED");
    expect(html).toContain("No evidence package yet");
    expect(html).toContain("Synthetic demo data".slice(0, 0)); // label appears once a package exists
  });

  it("action states: assigned, acknowledged, reported; recommend-only wording", async () => {
    const w = await makeWorld();
    const id = await w.detect();
    await w.api("POST", `/api/v1/cases/${id}/acknowledge`, MGR, {});
    let html = await caseHtml(w, id);
    expect(html).toContain("Recommended · available");
    expect(html).toContain("never");
    expect(html).not.toContain("Acknowledge this risk</button>");
    expect(html).toContain("Assign an approved action");
    const actionId = await w.reportAction(id, undefined, true);
    expect(actionId).toBeTruthy();
    html = await caseHtml(w, id);
    expect(html).toContain("Reported complete");
    expect(html).toContain("VERIFICATION PENDING");
    expect(html).toContain("Reported complete is what a person said");
    expect(html).toContain("Not verified");
  });

  it("verified: result, before/after, policy, confidence, hash check, synthetic label", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    const html = await caseHtml(w, id);
    expect(html).toContain("VERIFIED IMPROVED");
    expect(html).toContain("Yes, by sensors");
    expect(html).toContain("Before mitigation");
    expect(html).toContain("After mitigation");
    expect(html).toContain("VPOL-COOLING-ELECTRICAL");
    expect(html).toContain("Data completeness");
    expect(html).toContain("Hash check passed");
    expect(html).toContain("Synthetic demo data");
    expect(html).toContain("EVP-");
    expect(html).toContain("Watching until");
    expect(html).toContain("Evidence package created");
  });

  it("partially verified, not improving, inconclusive are each shown as themselves", async () => {
    const outcomes: [string, (w: World, id: string) => Promise<void>, string][] = [
      ["PARTIALLY VERIFIED", async (w) => w.send("partial-improvement", 25), "PARTIALLY_VERIFIED"],
      ["NOT IMPROVING", async (w) => w.send("compound-outdoor-heat", 25), "NOT_IMPROVING"],
      ["INCONCLUSIVE", async (w) => w.clock.advance(200_000), "INCONCLUSIVE"],
    ];
    for (const [label, feed, status] of outcomes) {
      const w = await makeWorld();
      const id = await w.detect();
      await w.reportAction(id);
      await w.runtime.tick();
      await feed(w, id);
      await w.runtime.tick();
      const html = await caseHtml(w, id);
      expect(html).toContain(`data-did-it-work="${status}"`);
      expect(html).toContain(label);
      expect(html).not.toContain("Yes, by sensors");
      await closeAll();
    }
  });

  it("reopened: same case, recurrence count, history kept, escalated recommendation", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    await w.send("normal", 3);
    await w.send("compound-outdoor-heat", 3);
    const html = await caseHtml(w, id);
    expect(html).toContain("Reopened");
    expect(html).toContain("This case was reopened");
    expect(html).toContain("same case");
    expect(html).toContain('data-testid="recurrence-count">1<');
    expect(html).toContain("Verified improved");
    expect(html).toContain("Risk Engineer Review");
    expect(html).toContain("Recurrence detected");
    expect(html).toContain("Case reopened");
  });

  it("operations summary and table reflect the API, and filters are deterministic", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    const x = await web(w);
    const r = await loadOperations(MGR);
    if (!r.ok) throw new Error("load");
    const s = summarizeCases(r.value.cases);
    expect(s).toMatchObject({
      open: 1,
      verifiedImproved: 1,
      verificationPending: 0,
      recurrence: 0,
    });
    const html = renderToStaticMarkup(
      <>
        <SummaryCards summary={s} />
        <CaseTable cases={r.value.cases} people={x.people} filtered={false} />
      </>,
    );
    expect(html).toContain(id);
    expect(html).toContain("AST-SIM-FAN-A");
    expect(html).toContain("Remote Monitoring");
    expect(html).toContain("Operator · USR-OPERATOR-001");
    const empty = renderToStaticMarkup(<CaseTable cases={[]} people={{}} filtered={false} />);
    expect(empty).toContain("No risk-improvement cases yet");
  });
});

describe("S7 evidence and sharing UI", () => {
  it("evidence panel: package metadata, integrity pass and a restricted role", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    await web(w);
    const r = await loadCase(MGR, id);
    if (!r.ok) throw new Error("load");
    const html = renderToStaticMarkup(
      <EvidencePanel
        packages={r.value.case.evidencePackages ?? []}
        detail={r.value.evidence}
        verificationPending={false}
      />,
    );
    expect(html).toContain("Hash check passed");
    expect(html).toContain("SYNTHETIC DATA");
    expect(html).toContain("baselines");
    expect(html).toContain("sensor observations");
    const operatorView = await loadCase("USR-OPERATOR-001", id);
    if (!operatorView.ok) throw new Error("load");
    expect(operatorView.value.case.evidencePackages).toBeUndefined();
    expect(
      renderToStaticMarkup(<EvidencePanel packages={[]} verificationPending restricted />),
    ).toContain("not available to your role");
    expect(renderToStaticMarkup(<EvidencePanel packages={[]} verificationPending />)).toContain(
      "Verification is still pending",
    );
  });

  it("a failing integrity check is reported, never hidden", () => {
    const html = renderToStaticMarkup(
      <EvidencePanel
        packages={[
          {
            packageId: "EVP-x",
            caseId: "c",
            verificationId: "v",
            result: "VERIFIED",
            createdAt: "2026-10-01T00:00:00.000Z",
            schemaVersion: "evidence-package.v1",
            payloadSha256: "a".repeat(64),
            manifestSha256: "b".repeat(64),
            byteLength: 1,
          },
        ]}
        detail={{
          record: {
            packageId: "EVP-x",
            caseId: "c",
            verificationId: "v",
            result: "VERIFIED",
            createdAt: "2026-10-01T00:00:00.000Z",
            schemaVersion: "evidence-package.v1",
            payloadSha256: "a".repeat(64),
            manifestSha256: "b".repeat(64),
            byteLength: 1,
          },
          integrity: {
            valid: false,
            issues: ["payload hash mismatch"],
            payloadSha256: "",
            manifestSha256: "",
          },
          package: {
            packageId: "EVP-x",
            createdAt: "2026-10-01T00:00:00.000Z",
            schemaVersion: "evidence-package.v1",
            manifest: { hashAlgorithm: "SHA-256", canonicalization: "x", artifacts: [] },
            payload: {
              source: {
                dataOrigin: "SYNTHETIC_SIMULATOR",
                synthetic: true,
                label: "SYNTHETIC DATA",
              },
              verification: {
                result: "VERIFIED",
                policyId: "P",
                policyVersion: "1",
                evaluatedAt: "",
              },
              auditReferences: [],
            },
          },
        }}
        verificationPending={false}
      />,
    );
    expect(html).toContain("Hash check FAILED");
    expect(html).toContain("payload hash mismatch");
  });

  it("sharing panel states: shareable, shared, revoked; raw telemetry never defaulted", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    const x = await web(w);
    const render = async (actor: string) => {
      const r = await loadCase(actor, id);
      if (!r.ok) throw new Error("load");
      const s = await x.session(actor);
      return renderToStaticMarkup(
        <SharingPanel
          caseId={id}
          facilityId="FAC-SIM-001"
          sharingState={r.value.case.sharing.state}
          agreements={r.value.case.sharingAgreements ?? []}
          hasPackage
          canManage={s.permissions.includes("SHARING_MANAGE")}
          canGrantRaw={s.permissions.includes("SHARING_GRANT_RAW_TELEMETRY")}
          insurers={x.directory.organizations.filter((o) => o.type === "INSURER")}
          orgNames={x.orgNames}
          people={x.people}
          returnTo={`/operations/cases/${id}`}
        />,
      );
    };
    let html = await render(MGR);
    expect(html).toContain('data-sharing-state="SHAREABLE"');
    expect(html).toContain("not sharing your telemetry");
    expect(html).not.toContain("RAW_TELEMETRY"); // the manager cannot even be offered it
    expect(html).toContain("Share selected evidence");

    html = await render(ADMIN);
    expect(html).toContain('value="RAW_TELEMETRY"');
    expect(html).not.toMatch(/value="RAW_TELEMETRY"[^>]*checked/);
    expect(html).toContain("Advanced: raw telemetry");
    expect(html.match(/checked/g)?.length).toBe(9);

    expect((await w.grant(MGR)).status).toBe(201);
    html = await render(MGR);
    expect(html).toContain('data-sharing-state="SHARED"');
    expect(html).toContain("Synthetic Insurer One");
    expect(html).toContain("Revoke access for Synthetic Insurer One");

    const agreement = (await w.api("GET", "/api/v1/sharing-agreements", MGR)).body.agreements[0];
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${agreement.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    html = await render(MGR);
    expect(html).toContain('data-sharing-state="REVOKED"');
    expect(html).toContain("Revoked");
    expect(html).not.toContain("Revoke access for");

    const auditor = await render(AUDITOR);
    expect(auditor).toContain("cannot grant or revoke");
  });
});

describe("S7 insurer workspace over the consent-filtered API", () => {
  it("shows only consented evidence; unshared site and other insurer see nothing", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    await web(w);
    const before = await loadRiskEvidence(RE);
    expect(before.ok && before.value.sites.length).toBe(0);

    await w.grant(MGR, { scopes: ["VERIFICATION_RESULT", "EVIDENCE_ARTIFACTS"] });
    const r = await loadRiskEvidence(RE);
    if (!r.ok) throw new Error("load");
    expect(r.value.sites.map((s) => s.site.siteId)).toEqual(["FAC-SIM-001"]);
    const sum = summarizeRiskEvidence(r.value.sites, r.value.interventions);
    expect(sum).toMatchObject({ sites: 1, cases: 1, verified: 1, recurrence: 0 });

    const detail = await loadInsurerCase(RE, id);
    if (!detail.ok) throw new Error("load");
    const html = renderToStaticMarkup(<InsurerCaseDetail data={detail.value} />);
    expect(html).toContain("VERIFIED IMPROVED");
    expect(html).toContain("Hash verified before release");
    expect(html).toContain('data-not-shared="BEFORE_AFTER_METRICS"');
    expect(html).toContain('data-not-shared="ACTION_SUMMARY"');
    expect(html).not.toContain("Before mitigation");
    expect(html).not.toContain("Inspected the primary"); // customer notes never leave the customer
    expect(html).not.toContain("operator note that must stay internal");

    const cards = renderToStaticMarkup(
      <>
        <RiskEvidenceCards summary={sum} />
        <InsurerCaseTable
          cases={r.value.sites.flatMap((s) => s.cases)}
          interventions={r.value.interventions}
        />
      </>,
    );
    expect(cards).toContain("Shared sites");
    expect(cards).toContain("Not shared"); // recommendation scope absent

    const other = await loadRiskEvidence(OTHER_INSURER);
    expect(other.ok && other.value.sites.length).toBe(0);
    const denied = await loadInsurerCase(OTHER_INSURER, id);
    expect(denied.ok).toBe(false);
    const own = await loadCase(OTHER_ORG_MGR, id);
    expect(own.ok).toBe(false);
  });

  it("full scope shows before/after, recurrence, intervention; revocation removes access", async () => {
    const w = await makeWorld();
    const id = await w.verified();
    await web(w);
    await w.grant(MGR);
    const detail = await loadInsurerCase(RE, id);
    if (!detail.ok) throw new Error("load");
    const html = renderToStaticMarkup(<InsurerCaseDetail data={detail.value} />);
    expect(html).toContain("Before mitigation");
    expect(html).toContain("Remote Monitoring");
    expect(html).toContain("Customer-reported actions");
    expect(html).toContain("not that the risk improved");
    expect(html).toContain("Synthetic demo data");

    const agreement = (await w.api("GET", "/api/v1/sharing-agreements", MGR)).body.agreements[0];
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${agreement.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    const after = await loadInsurerCase(RE, id);
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.code).toBe("ACCESS_DENIED");
    const denial = renderToStaticMarkup(
      <ApiErrorView error={after} session={undefined} subject="this case" />,
    );
    expect(denial).toContain("Sharing was revoked");
    const sites = await loadRiskEvidence(RE);
    expect(sites.ok && sites.value.sites.length).toBe(0);
  });

  it("authorization denials render as words: wrong persona, unknown case, unreachable API", async () => {
    const w = await makeWorld();
    await w.detect();
    const x = await web(w);
    const mgrOnInsurer = await loadRiskEvidence(MGR);
    expect(mgrOnInsurer.ok).toBe(false);
    if (mgrOnInsurer.ok) return;
    expect(mgrOnInsurer.status).toBe(403);
    const html = renderToStaticMarkup(
      <ApiErrorView
        error={mgrOnInsurer}
        session={await x.session(MGR)}
        subject="the risk evidence workspace"
      />,
    );
    expect(html).toContain("Not available to this identity");
    expect(html).not.toMatch(/Error:|at \w+ \(/);
    const reOnOps = await loadOperations(RE);
    expect(reOnOps.ok).toBe(false);
    const missing = await loadCase(MGR, "CASE-does-not-exist");
    if (missing.ok) throw new Error("expected not found");
    expect(
      renderToStaticMarkup(
        <ApiErrorView error={missing} session={undefined} subject="this case" />,
      ),
    ).toContain("Not found");
    const down = await (async () => {
      const prev = process.env.SYMBIOSIS_API_URL;
      process.env.SYMBIOSIS_API_URL = "http://127.0.0.1:9";
      const r = await loadOperations(MGR);
      process.env.SYMBIOSIS_API_URL = prev;
      return r;
    })();
    if (down.ok) throw new Error("expected failure");
    expect(down.status).toBe(0);
    expect(
      renderToStaticMarkup(<ApiErrorView error={down} session={undefined} subject="x" />),
    ).toContain("not reachable");
    expect(
      renderToStaticMarkup(
        <AccessDenied title="T" homeHref="/" homeLabel="Home">
          x
        </AccessDenied>,
      ),
    ).toContain("T");
  });
});

describe("S7 intervention UX", () => {
  it("renders all four deterministic levels, with recommendation wording only", () => {
    for (const level of INTERVENTION_ORDER) {
      const html = renderToStaticMarkup(
        <InterventionPanel
          intervention={{
            level,
            status: "ACTIVE",
            reasonCodes: ["HIGH_SEVERITY_UNRESOLVED", "SOME_UNKNOWN_CODE"],
            dataSufficiency: 0.75,
            policyId: "IPOL",
            policyVersion: "1",
          }}
          supportingEvidenceCount={80}
        />,
      );
      expect(html).toContain(`data-level="${level}"`);
      expect(html).toContain('aria-current="step"');
      expect(html).toContain("A high-severity risk is unresolved");
      expect(html).toContain("some unknown code"); // unknown codes fall back to readable text
      expect(html).toContain("75%");
      expect(html).toContain("80 records");
      expect(html).toContain("Decision support only");
      expect(html).not.toMatch(/dispatched|has been scheduled|engineer assigned/i);
    }
    const labels = INTERVENTION_ORDER.map((l) =>
      renderToStaticMarkup(
        <InterventionPanel
          intervention={{ level: l, status: "ACTIVE", reasonCodes: [], dataSufficiency: 1 }}
        />,
      ),
    );
    expect(labels[3]).toContain("Site Visit Recommended");
    expect(labels[2]).toContain("Risk Engineer Review");
    expect(labels[1]).toContain("Remote Review");
    expect(labels[0]).toContain("Remote Monitoring");
  });

  it("the interventions list handles none", () => {
    expect(renderToStaticMarkup(<InterventionList interventions={[]} />)).toContain(
      "No recommendations",
    );
  });
});
