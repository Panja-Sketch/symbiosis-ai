import { afterEach, describe, expect, it } from "vitest";
import type { AuditEntry, VerificationAttempt } from "@symbiosis/contracts";
import { createInsuranceGateway } from "@symbiosis/consent";
import { InMemoryEvidenceObjectStore } from "@symbiosis/evidence";
import {
  ADMIN,
  AUDITOR,
  FAC,
  MGR,
  OPERATOR,
  ORG,
  OTHER_INSURER,
  OTHER_ORG_MGR,
  RE,
  STANDARD_SCOPES,
  UW,
  closeAll,
  makeWorld,
} from "./s6-world";
import type { Json, World } from "./s6-world";

afterEach(closeAll);

const SECTION_KEYS = [
  "recommendation",
  "eventSummary",
  "actionSummary",
  "verification",
  "confidence",
  "beforeAfter",
  "recurrence",
  "evidencePackage",
] as const;

const SCOPE_TO_SECTION: Record<string, (typeof SECTION_KEYS)[number]> = {
  RECOMMENDATION: "recommendation",
  EVENT_SUMMARY: "eventSummary",
  ACTION_SUMMARY: "actionSummary",
  BEFORE_AFTER_METRICS: "beforeAfter",
  VERIFICATION_RESULT: "verification",
  VERIFICATION_CONFIDENCE: "confidence",
  RECURRENCE_STATUS: "recurrence",
  EVIDENCE_ARTIFACTS: "evidencePackage",
};

const sections = (body: Json) => SECTION_KEYS.filter((k) => body[k] !== undefined);
const state = async (w: World, caseId: string) =>
  (await w.runtime.cases.get(ORG, caseId))?.sharingState;
const evidence = (w: World, caseId: string, actor = RE, query = "") =>
  w.api("GET", `/insurance/v1/cases/${caseId}/evidence${query}`, actor);

describe("C1 sharing state follows real events, not the existence of a package", () => {
  it("NOT_SHARED -> SHAREABLE -> SHARED -> REVOKED -> SHARED again", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    expect(await state(w, caseId)).toBe("NOT_SHARED");
    await w.reportAction(caseId);
    await w.runtime.tick();
    expect(await state(w, caseId)).toBe("NOT_SHARED"); // pending verification: nothing to share
    await w.send("normal", 25);
    await w.runtime.tick();
    expect(await state(w, caseId)).toBe("SHAREABLE");

    const g1 = await w.grant(MGR);
    expect(g1.status).toBe(201);
    expect(await state(w, caseId)).toBe("SHARED");
    expect(g1.body.sharedCaseIds).toEqual([caseId]);

    const r = await w.api(
      "POST",
      `/api/v1/sharing-agreements/${g1.body.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    expect(r.status).toBe(200);
    expect(await state(w, caseId)).toBe("REVOKED");

    w.clock.advance(1000);
    const g2 = await w.grant(MGR);
    expect(g2.status).toBe(201);
    expect(await state(w, caseId)).toBe("SHARED");
    const changes = (await w.runtime.audit.listByCase(ORG, caseId))
      .filter((e) => e.action === "SHARING_STATE_CHANGED")
      .map((e) => `${e.beforeState}>${e.afterState}`);
    expect(changes).toEqual([
      "NOT_SHARED>SHAREABLE",
      "SHAREABLE>SHARED",
      "SHARED>REVOKED",
      "REVOKED>SHARED",
    ]);
    expect(w.runtime.bus.deadLetters()).toEqual([]);
  });

  it("a package alone is never SHARED, and the insurer has no access until an agreement exists", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    expect(await state(w, caseId)).toBe("SHAREABLE");
    expect(w.types()).not.toContain("evidence.shared.v1");
    const denied = await evidence(w, caseId);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({
      code: "ACCESS_DENIED",
      reason: "NO_AGREEMENT_FOR_TARGET",
    });
    expect(Object.keys(denied.body)).toEqual(["error"]);
    expect((await w.api("GET", "/insurance/v1/sites", RE)).body.sites).toEqual([]);
    expect((await w.api("GET", "/insurance/v1/recommendations", RE)).body.recommendations).toEqual(
      [],
    );
  });

  it("an agreement that releases no package scope does not make the case SHARED", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const g = await w.grant(MGR, { scopes: ["RECOMMENDATION", "INTERVENTION_RECOMMENDATION"] });
    expect(g.status).toBe(201);
    expect(await state(w, caseId)).toBe("SHAREABLE");
    expect(w.types()).not.toContain("evidence.shared.v1");
    const ev = await evidence(w, caseId);
    expect(ev.status).toBe(403);
    expect(ev.body.error.reason).toBe("SCOPE_NOT_GRANTED");
    const rec = await w.api("GET", "/insurance/v1/recommendations", RE);
    expect(rec.body.recommendations).toHaveLength(1);
    expect(sections(rec.body.recommendations[0])).toEqual(["recommendation"]);
  });

  it("revoking one of two agreements leaves the case SHARED; revoking the last makes it REVOKED", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const a = await w.grant(MGR);
    const b = await w.grant(MGR, { recipientOrganizationId: "ORG-INS-002" });
    w.clock.advance(1000);
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${a.body.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    expect(await state(w, caseId)).toBe("SHARED");
    expect((await evidence(w, caseId, RE)).status).toBe(403);
    expect((await evidence(w, caseId, OTHER_INSURER)).status).toBe(200);
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${b.body.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    expect(await state(w, caseId)).toBe("REVOKED");
    expect((await evidence(w, caseId, OTHER_INSURER)).status).toBe(403);
  });

  it("sharing, reading and revoking never modify the verification, the case state or the package", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const attempt = (
      await w.runtime.verifications.listByCase(ORG, caseId)
    )[0] as VerificationAttempt;
    const frozen = JSON.stringify(attempt);
    const pkg = await w.latestPackage(caseId);
    const g = await w.grant(MGR);
    await evidence(w, caseId);
    await w.api("GET", "/insurance/v1/sites", RE);
    w.clock.advance(1000);
    await w.api(
      "POST",
      `/api/v1/sharing-agreements/${g.body.agreement.agreementId}/revoke`,
      MGR,
      {},
    );
    expect(JSON.stringify((await w.runtime.verifications.listByCase(ORG, caseId))[0])).toBe(frozen);
    const c = await w.runtime.cases.get(ORG, caseId);
    expect(c).toMatchObject({
      state: "VERIFIED_IMPROVED",
      latestVerificationId: attempt.verificationId,
    });
    expect(await w.latestPackage(caseId)).toEqual(pkg);
    expect(w.types().filter((t) => t.startsWith("verification."))).toHaveLength(2);
  });
});

describe("C2 creating a sharing agreement", () => {
  it("derives the granting organization and creator on the server and records an audited, evented grant", async () => {
    const w = await makeWorld();
    await w.verified();
    const r = await w.grant(MGR, {
      organizationId: "ORG-SIM-002", // ignored: never taken from the request
      createdBy: "USR-SOMEONE-ELSE",
      scopes: ["VERIFICATION_RESULT", "RECOMMENDATION", "VERIFICATION_RESULT"],
    });
    expect(r.status).toBe(201);
    expect(r.body.agreement).toMatchObject({
      organizationId: ORG,
      createdBy: MGR,
      recipientOrganizationId: "ORG-INS-001",
      facilityIds: [FAC],
      scopes: ["RECOMMENDATION", "VERIFICATION_RESULT"],
      effectiveFrom: new Date(w.clock.nowMs()).toISOString(),
    });
    expect(r.body.agreement.revokedAt).toBeUndefined();
    expect(r.body.status).toBe("ACTIVE");
    const ev = w.runtime.bus.history().find((e) => e.event_type === "consent.granted.v1");
    expect(ev).toMatchObject({
      organization_id: ORG,
      facility_id: FAC,
      producer: "api",
      payload: { agreementId: r.body.agreement.agreementId, includesRawTelemetry: false },
    });
    const audit = (await w.runtime.audit.list(ORG)).find(
      (e) => e.action === "SHARING_AGREEMENT_CREATED",
    );
    expect(audit).toMatchObject({
      actorId: MGR,
      actorType: "USER",
      targetType: "SHARING_AGREEMENT",
      targetId: r.body.agreement.agreementId,
    });
    expect(audit?.correlationId).toBe(ev?.correlation_id);
  });

  it("rejects invalid requests with specific codes", async () => {
    const w = await makeWorld();
    await w.verified();
    const bad = async (patch: Record<string, unknown>, code: string, status = 400) => {
      const r = await w.grant(MGR, patch);
      expect(r.status, JSON.stringify(patch)).toBe(status);
      if (status === 400) expect(r.body.error.details.join(" ")).toContain(code);
    };
    await bad({ scopes: ["NOT_A_SCOPE"] }, "UNKNOWN_SCOPE:NOT_A_SCOPE");
    await bad({ scopes: [] }, "SCOPES_REQUIRED");
    await bad({ scopes: "RECOMMENDATION" }, "SCOPES_REQUIRED");
    await bad({ facilityIds: [] }, "FACILITIES_REQUIRED");
    await bad({ facilityIds: ["FAC-OTHER-001"] }, "FACILITY_NOT_IN_ORGANIZATION:FAC-OTHER-001");
    await bad({ recipientOrganizationId: ORG }, "RECIPIENT_MUST_DIFFER_FROM_GRANTOR");
    await bad({ recipientOrganizationId: "ORG-NOBODY" }, "RECIPIENT_UNKNOWN_OR_NOT_ELIGIBLE");
    await bad({ recipientOrganizationId: "ORG-SIM-002" }, "RECIPIENT_UNKNOWN_OR_NOT_ELIGIBLE");
    await bad({ recipientOrganizationId: undefined }, "RECIPIENT_REQUIRED");
    await bad({ effectiveFrom: "yesterday" }, "EFFECTIVE_FROM_INVALID");
    await bad({ expiresAt: "tomorrow" }, "EXPIRES_AT_INVALID");
    await bad(
      { effectiveFrom: "2026-10-02T00:00:00Z", expiresAt: "2026-10-01T12:00:00Z" },
      "EXPIRES_AT_NOT_AFTER_EFFECTIVE_FROM",
    );
    await bad(
      { expiresAt: "2026-09-30T00:00:00Z", effectiveFrom: "2026-09-29T00:00:00Z" },
      "EXPIRES_AT_IN_THE_PAST",
    );
    const malformed = await fetch(`${w.runtime.server.baseUrl}/api/v1/sharing-agreements`, {
      method: "POST",
      headers: { "X-Demo-Actor-Id": MGR },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await w.runtime.agreements.listForOwner(ORG)).toEqual([]);
    expect(w.types()).not.toContain("consent.granted.v1");
  });

  it("enforces who may grant, and raw telemetry needs its own permission", async () => {
    const w = await makeWorld();
    await w.verified();
    expect((await w.grant(OPERATOR)).status).toBe(403);
    expect((await w.grant(AUDITOR)).status).toBe(403);
    expect((await w.grant(RE)).status).toBe(403);
    expect((await w.grant(UW)).status).toBe(403);
    expect((await w.grant("USR-NOBODY")).status).toBe(401);
    // a manager of another tenant cannot grant on this tenant's facility
    expect((await w.grant(OTHER_ORG_MGR)).status).toBe(400);
    // raw telemetry: the manager cannot, the administrator can, and it is explicit
    const asManager = await w.grant(MGR, { scopes: [...STANDARD_SCOPES, "RAW_TELEMETRY"] });
    expect(asManager.status).toBe(403);
    expect(asManager.body.error.message).toContain("SHARING_GRANT_RAW_TELEMETRY");
    const asAdmin = await w.grant(ADMIN, { scopes: ["RAW_TELEMETRY"] });
    expect(asAdmin.status).toBe(201);
    expect(asAdmin.body.agreement.scopes).toEqual(["RAW_TELEMETRY"]);
    expect(
      w.runtime.bus.history().find((e) => e.event_type === "consent.granted.v1")?.payload,
    ).toMatchObject({ includesRawTelemetry: true });
    // the standard grant contains no raw scope
    expect(STANDARD_SCOPES).not.toContain("RAW_TELEMETRY");
  });

  it("lists and reads only the actor's own organization's agreements", async () => {
    const w = await makeWorld();
    await w.verified();
    const g = await w.grant(MGR);
    const id = g.body.agreement.agreementId as string;
    expect((await w.api("GET", "/api/v1/sharing-agreements", MGR)).body.agreements).toHaveLength(1);
    expect((await w.api("GET", `/api/v1/sharing-agreements/${id}`, AUDITOR)).status).toBe(200);
    expect(
      (await w.api("GET", "/api/v1/sharing-agreements", OTHER_ORG_MGR)).body.agreements,
    ).toEqual([]);
    expect((await w.api("GET", `/api/v1/sharing-agreements/${id}`, OTHER_ORG_MGR)).status).toBe(
      404,
    );
    expect((await w.api("GET", "/api/v1/sharing-agreements", RE)).status).toBe(403);
    expect((await w.api("GET", `/api/v1/sharing-agreements/${id}`, OPERATOR)).status).toBe(403);
    expect((await w.api("DELETE", `/api/v1/sharing-agreements/${id}`, MGR)).status).toBe(405);
  });
});

describe("C3 every insurer read is authorized against the stored agreement", () => {
  it("each scope releases exactly its own section and nothing else", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    for (const scope of Object.keys(SCOPE_TO_SECTION)) {
      const fresh = await makeWorld();
      const id = await fresh.verified();
      expect((await fresh.grant(MGR, { scopes: [scope] })).status).toBe(201);
      const view = await fresh.api("GET", `/insurance/v1/cases/${id}`, RE);
      expect(view.status, scope).toBe(200);
      expect(sections(view.body), scope).toEqual([SCOPE_TO_SECTION[scope]]);
      expect(view.body.rawTelemetry).toBeUndefined();
      const ev = await evidence(fresh, id);
      if (scope === "RECOMMENDATION") {
        expect(ev.status).toBe(403);
      } else {
        expect(ev.status, scope).toBe(200);
        expect(sections(ev.body), scope).toEqual([SCOPE_TO_SECTION[scope]]);
        expect(ev.body.source.synthetic).toBe(true); // synthetic data is always labelled
      }
      await closeAll();
    }
    void w;
    void caseId;
  });

  it("the full standard grant releases every section but never raw telemetry", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await w.grant(MGR);
    const ev = await evidence(w, caseId);
    expect(ev.status).toBe(200);
    expect(sections(ev.body)).toEqual([...SECTION_KEYS]);
    expect(ev.body.rawTelemetry).toBeUndefined();
    expect(ev.body.verification).toMatchObject({
      result: "VERIFIED",
      resultLabel: "VERIFIED IMPROVED",
      policyId: "VPOL-COOLING-ELECTRICAL",
      policyVersion: "1",
    });
    expect(ev.body.confidence).toMatchObject({
      dataCompleteness: 1,
      authIntegrityStatus: "VERIFIED",
    });
    expect(ev.body.eventSummary.detectionReasonCodes.length).toBeGreaterThan(0);
    expect(ev.body.actionSummary.actions[0]).toMatchObject({
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
    });
    expect(ev.body.recurrence).toMatchObject({
      currentRecurrenceCount: 0,
      reopenedSincePackage: false,
    });
    expect(ev.body.beforeAfter.length).toBeGreaterThan(3);
    expect(ev.body.evidencePackage).toMatchObject({
      integrity: "VERIFIED",
      observationArtifactCount: expect.any(Number),
    });
    expect(ev.body.evidencePackage.artifacts.every((a: Json) => a.kind !== "OBSERVATION")).toBe(
      true,
    );
    expect(ev.body.evidencePackage.observationArtifactCount).toBeGreaterThan(20);
    // nothing operational leaks: no notes, actors, raw values, device or key facts
    const text = JSON.stringify(ev.body);
    expect(text).not.toMatch(
      /operator note that must stay internal|USR-|"observationId"|"snapshot"|KEY-SIM|firmware/i,
    );
    expect(ev.body.packageHistory).toHaveLength(1);
  });

  it("raw telemetry is a separate explicit scope on an explicit request", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await w.grant(MGR); // broad grant: no raw scope
    const denied = await evidence(w, caseId, RE, "?include=raw_telemetry");
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "ACCESS_DENIED", reason: "SCOPE_NOT_GRANTED" });
    expect(Object.keys(denied.body)).toEqual(["error"]);
    expect((await evidence(w, caseId, RE, "?include=everything")).status).toBe(400);

    const asAdmin = await w.grant(ADMIN, {
      scopes: ["RAW_TELEMETRY"],
      recipientOrganizationId: "ORG-INS-002",
    });
    expect(asAdmin.status).toBe(201);
    // the raw scope alone does not release the summary endpoint, and nothing is returned unrequested
    expect((await evidence(w, caseId, OTHER_INSURER)).status).toBe(403);
    const raw = await evidence(w, caseId, OTHER_INSURER, "?include=raw_telemetry");
    expect(raw.status).toBe(200);
    expect(raw.body.rawTelemetry.scope).toBe("RAW_TELEMETRY");
    expect(raw.body.rawTelemetry.observations.length).toBeGreaterThan(20);
    expect(raw.body.rawTelemetry.observations[0]).toHaveProperty("signal");
    expect(sections(raw.body)).toEqual([]); // no other scope was granted to this recipient
    const audit = (await w.runtime.audit.list(ORG)).filter(
      (e) => e.action === "INSURER_EVIDENCE_READ" && e.actorId === OTHER_INSURER,
    );
    expect(audit.at(-1)?.details).toMatchObject({ rawTelemetryReleased: true });

    // a recipient holding both scopes still gets raw data only when it asks
    await w.grant(ADMIN, { scopes: ["RAW_TELEMETRY"] });
    const plain = await evidence(w, caseId, RE);
    expect(plain.body.rawTelemetry).toBeUndefined();
    expect(
      (await evidence(w, caseId, RE, "?include=raw_telemetry")).body.rawTelemetry,
    ).toBeDefined();
  });

  it("denies the wrong recipient, the wrong facility and other tenants, with one uniform answer", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await w.grant(MGR);
    expect((await evidence(w, caseId, OTHER_INSURER)).status).toBe(403);
    expect((await w.api("GET", "/insurance/v1/sites/FAC-OTHER-001/cases", RE)).status).toBe(403);
    const unknown = await evidence(w, "CASE-DOES-NOT-EXIST", RE);
    expect(unknown.status).toBe(403);
    const otherInsurerExisting = await evidence(w, caseId, OTHER_INSURER);
    const otherInsurerUnknown = await evidence(w, "CASE-DOES-NOT-EXIST", OTHER_INSURER);
    expect(otherInsurerExisting.body).toEqual(otherInsurerUnknown.body); // existence is not revealed
    expect(unknown.body.error.reason).toBe("NO_AGREEMENT_FOR_TARGET");
    // cross-tenant direct case id lookup through the application API
    expect((await w.api("GET", `/api/v1/cases/${caseId}`, OTHER_ORG_MGR)).status).toBe(404);
    expect((await w.api("GET", `/api/v1/cases/${caseId}`, RE)).status).toBe(403);
    // the insured cannot use the insurance API, and the API is read-only
    expect((await w.api("GET", `/insurance/v1/cases/${caseId}`, MGR)).status).toBe(403);
    expect((await w.api("POST", `/insurance/v1/cases/${caseId}`, RE, {})).status).toBe(405);
    expect((await w.api("GET", `/insurance/v1/cases/${caseId}`, "USR-NOBODY")).status).toBe(401);
    expect((await w.api("GET", "/insurance/v1/unknown", RE)).status).toBe(404);
    // the recipient comes from the actor: a header claiming another organization changes nothing
    const spoof = await fetch(`${w.runtime.server.baseUrl}/insurance/v1/cases/${caseId}/evidence`, {
      headers: { "X-Demo-Actor-Id": OTHER_INSURER, "X-Organization-Id": "ORG-INS-001" },
    });
    expect(spoof.status).toBe(403);
    const asUnderwriter = await w.api("GET", `/insurance/v1/cases/${caseId}/evidence`, UW);
    expect(asUnderwriter.status).toBe(200); // same insurer organization, permitted role
  });

  it("an expired agreement is denied from the moment it expires", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const expiresAt = new Date(w.clock.nowMs() + 60_000).toISOString();
    await w.grant(MGR, { expiresAt });
    expect((await evidence(w, caseId)).status).toBe(200);
    w.clock.advance(59_999);
    expect((await evidence(w, caseId)).status).toBe(200);
    w.clock.advance(1);
    const expired = await evidence(w, caseId);
    expect(expired.status).toBe(403);
    expect(expired.body.error.reason).toBe("AGREEMENT_EXPIRED");
    expect((await w.api("GET", "/insurance/v1/sites", RE)).body.sites).toEqual([]);
    expect(await state(w, caseId)).toBe("SHARED"); // stale until reconciled
    await w.runtime.tick();
    expect(await state(w, caseId)).toBe("REVOKED");
  });

  it("an agreement that is not yet effective is denied, then works once it begins", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const effectiveFrom = new Date(w.clock.nowMs() + 3_600_000).toISOString();
    const g = await w.grant(MGR, { effectiveFrom });
    expect(g.body.status).toBe("NOT_YET_EFFECTIVE");
    expect(await state(w, caseId)).toBe("SHAREABLE");
    const early = await evidence(w, caseId);
    expect(early.body.error.reason).toBe("AGREEMENT_NOT_YET_EFFECTIVE");
    w.clock.advance(3_600_000);
    expect((await evidence(w, caseId)).status).toBe(200);
    await w.runtime.tick(); // the scheduler records the release
    expect(await state(w, caseId)).toBe("SHARED");
  });

  it("revocation takes effect immediately for every endpoint and preserves the agreement", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const g = await w.grant(MGR);
    const id = g.body.agreement.agreementId as string;
    expect((await evidence(w, caseId)).status).toBe(200);
    // no clock movement at all between the read and the revocation
    const r = await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, MGR, {
      reason: "contract ended",
    });
    expect(r.status).toBe(200);
    expect(r.body.agreement).toMatchObject({
      agreementId: id,
      revokedBy: MGR,
      revocationReason: "contract ended",
      scopes: STANDARD_SCOPES,
      createdBy: MGR,
    });
    expect(r.body.agreement.revokedAt).toBe(new Date(w.clock.nowMs()).toISOString());
    expect(r.body.status).toBe("REVOKED");
    for (const path of [
      `/insurance/v1/cases/${caseId}`,
      `/insurance/v1/cases/${caseId}/evidence`,
      `/insurance/v1/sites/${FAC}/cases`,
    ]) {
      const denied = await w.api("GET", path, RE);
      expect(denied.status, path).toBe(403);
      expect(denied.body.error.reason).toBe("AGREEMENT_REVOKED");
    }
    for (const path of [
      "/insurance/v1/sites",
      "/insurance/v1/recommendations",
      "/insurance/v1/interventions",
    ]) {
      const empty = await w.api("GET", path, RE);
      expect(Object.values(empty.body)[0], path).toEqual([]);
    }
    // history and the evidence survive
    const kept = await w.api("GET", `/api/v1/sharing-agreements/${id}`, MGR);
    expect(kept.body.agreement.revokedAt).toBe(r.body.agreement.revokedAt);
    expect((await w.latestPackage(caseId)) !== undefined).toBe(true);
    const audit = (await w.runtime.audit.list(ORG)).map((e) => e.action);
    expect(audit).toContain("SHARING_AGREEMENT_CREATED");
    expect(audit).toContain("SHARING_AGREEMENT_REVOKED");
    expect(audit).toContain("INSURER_EVIDENCE_READ");
    expect(audit).toContain("INSURER_ACCESS_DENIED");
    const ev = w.runtime.bus.history().find((e) => e.event_type === "consent.revoked.v1");
    expect(ev).toMatchObject({ producer: "api", payload: { agreementId: id, revokedBy: MGR } });

    // it cannot be revoked twice, un-revoked or altered
    w.clock.advance(5000);
    const again = await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, MGR, {});
    expect(again.status).toBe(409);
    const after = await w.api("GET", `/api/v1/sharing-agreements/${id}`, MGR);
    expect(after.body.agreement.revokedAt).toBe(r.body.agreement.revokedAt);
  });

  it("only the owning organization, with permission, can revoke", async () => {
    const w = await makeWorld();
    await w.verified();
    const id = (await w.grant(MGR)).body.agreement.agreementId as string;
    expect(
      (await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, OTHER_ORG_MGR, {})).status,
    ).toBe(404);
    expect((await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, RE, {})).status).toBe(
      403,
    );
    expect(
      (await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, OPERATOR, {})).status,
    ).toBe(403);
    expect(
      (await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, AUDITOR, {})).status,
    ).toBe(403);
    expect((await w.api("POST", `/api/v1/sharing-agreements/NOPE/revoke`, MGR, {})).status).toBe(
      404,
    );
    expect(
      (await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, MGR, { reason: 5 })).status,
    ).toBe(400);
    expect((await w.runtime.agreements.getForOwner(ORG, id))?.revokedAt).toBeUndefined();
    expect((await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, ADMIN, {})).status).toBe(
      200,
    );
  });

  it("insurer reads are audited with actor, agreement and scopes; denials are audited too", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await evidence(w, caseId); // denied before consent
    const g = await w.grant(MGR, { scopes: ["VERIFICATION_RESULT"] });
    await evidence(w, caseId);
    await evidence(w, caseId, RE, "?include=raw_telemetry"); // denied: scope
    await evidence(w, "CASE-NOPE", RE); // denied: unreachable
    const owner = await w.runtime.audit.list(ORG);
    const reads = owner.filter((e) => e.action === "INSURER_EVIDENCE_READ");
    const denials = owner.filter((e) => e.action === "INSURER_ACCESS_DENIED");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({
      actorId: RE,
      actorType: "USER",
      organizationId: ORG,
      facilityId: FAC,
      caseId,
      targetType: "CASE",
      targetId: caseId,
    });
    expect(reads[0]?.details).toMatchObject({
      actorOrganizationId: "ORG-INS-001",
      agreementIds: [g.body.agreement.agreementId],
      grantedScopes: ["VERIFICATION_RESULT"],
      rawTelemetryReleased: false,
    });
    expect(reads[0]?.details?.evidencePackageId).toBe((await w.latestPackage(caseId))?.packageId);
    // the owner sees denials that reached its data; a probe that reached nothing is audited under
    // the requester's own organization (here: the pre-consent attempt and the unknown case)
    expect(denials.map((e) => e.details?.reason)).toEqual(["SCOPE_NOT_GRANTED"]);
    expect(denials[0]?.details?.internalReason).toBe("SCOPE_NOT_GRANTED:RAW_TELEMETRY");
    const own = await w.runtime.audit.list("ORG-INS-001");
    expect(own.map((e) => [e.action, e.targetId, e.details?.reason])).toEqual([
      ["INSURER_ACCESS_DENIED", caseId, "NO_AGREEMENT_FOR_TARGET"],
      ["INSURER_ACCESS_DENIED", "CASE-NOPE", "NO_AGREEMENT_FOR_TARGET"],
    ]);
    expect(own[0]).toMatchObject({ actorId: RE, facilityId: "UNSCOPED" });
    // correlation ids differ per read; the log is append-only (sequences only grow)
    const all = [...owner, ...own] as AuditEntry[];
    expect(new Set(all.map((e) => e.correlationId)).size).toBeGreaterThan(3);
  });

  it("fails closed: if the read cannot be audited, nothing is released", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await w.grant(MGR);
    const failingAudit = {
      append: async (e: Parameters<typeof w.runtime.audit.append>[0]) => {
        if (e.action === "INSURER_EVIDENCE_READ") throw new Error("audit store down");
        return w.runtime.audit.append(e);
      },
      listByCase: w.runtime.audit.listByCase.bind(w.runtime.audit),
      list: w.runtime.audit.list.bind(w.runtime.audit),
      listAfter: w.runtime.audit.listAfter.bind(w.runtime.audit),
      lastSequence: w.runtime.audit.lastSequence.bind(w.runtime.audit),
    };
    const gateway = createInsuranceGateway({
      ids: { next: (p: string) => `${p}-X` },
      clock: w.clock,
      audit: failingAudit,
      cases: w.runtime.cases,
      agreements: w.runtime.agreements,
      packages: w.runtime.evidencePackages,
      interventions: w.runtime.interventions,
      evidence: w.runtime.evidenceService,
    });
    const actor = await w.runtime.directory.get(RE);
    const r = await gateway.evidence(actor as NonNullable<typeof actor>, caseId);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("AUDIT_FAILURE");
    expect(r).not.toHaveProperty("value");
    const c = await gateway.caseView(actor as NonNullable<typeof actor>, caseId);
    expect(c.ok).toBe(false);
    // and a denial still stands when even the denial cannot be audited
    const noAgreement = await gateway.evidence(
      (await w.runtime.directory.get(OTHER_INSURER)) as NonNullable<typeof actor>,
      caseId,
    );
    expect(!noAgreement.ok && noAgreement.error.code).toBe("ACCESS_DENIED");
  });

  it("withholds a package that fails integrity verification", async () => {
    const store = new InMemoryEvidenceObjectStore();
    const w = await makeWorld({ evidenceStore: store });
    const caseId = await w.verified();
    await w.grant(MGR);
    const rec = await w.latestPackage(caseId);
    const text = (await store.get(rec?.objectKey ?? "")) as string;
    store.tamperForTest(rec?.objectKey ?? "", text.replace('"VERIFIED"', '"INCONCLUSIVE"'));
    const r = await evidence(w, caseId);
    expect(r.status).toBe(500);
    expect(r.body.error).toMatchObject({
      code: "INTEGRITY_FAILURE",
      reason: "EVIDENCE_INTEGRITY_FAILURE",
    });
    expect(Object.keys(r.body)).toEqual(["error"]);
    expect((await w.api("GET", `/insurance/v1/cases/${caseId}`, RE)).status).toBe(500);
    const denial = (await w.runtime.audit.list(ORG)).filter(
      (e) => e.action === "INSURER_ACCESS_DENIED",
    );
    expect(denial.at(-1)?.details?.reason).toBe("EVIDENCE_INTEGRITY_FAILURE");
  });
});

describe("C4 insurer lists", () => {
  it("sites, cases, recommendations and interventions are consent-filtered", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    await w.grant(MGR, { scopes: ["RECOMMENDATION", "VERIFICATION_RESULT"] });
    const sites = await w.api("GET", "/insurance/v1/sites", RE);
    expect(sites.body.sites).toEqual([
      {
        siteId: FAC,
        insuredOrganizationId: ORG,
        agreements: [
          expect.objectContaining({ scopes: ["RECOMMENDATION", "VERIFICATION_RESULT"] }),
        ],
      },
    ]);
    const cases = await w.api("GET", `/insurance/v1/sites/${FAC}/cases`, RE);
    expect(cases.status).toBe(200);
    expect(cases.body.cases).toHaveLength(1);
    expect(cases.body.cases[0]).toMatchObject({ caseId, sharingState: "SHARED" });
    expect(sections(cases.body.cases[0])).toEqual(["recommendation", "verification"]);
    const recs = await w.api("GET", "/insurance/v1/recommendations", RE);
    expect(recs.body.recommendations).toHaveLength(1);
    expect(sections(recs.body.recommendations[0])).toEqual(["recommendation"]); // no package section here
    // interventions need their own scope
    expect((await w.api("GET", "/insurance/v1/interventions", RE)).body.interventions).toEqual([]);
    await w.grant(MGR, { scopes: ["INTERVENTION_RECOMMENDATION"] });
    const ints = (await w.api("GET", "/insurance/v1/interventions", RE)).body
      .interventions as Json[];
    expect(ints.length).toBeGreaterThan(0);
    expect(ints.every((i) => i.status === "ACTIVE" || i.status === "ACKNOWLEDGED")).toBe(true);
    expect(ints[0]).toMatchObject({
      insuredOrganizationId: ORG,
      siteId: FAC,
      policyId: "IPOL-RISK-ENGINEER-PRIORITIZATION",
    });
    expect(ints[0]?.note).toMatch(/schedules no one/);
    expect(JSON.stringify(ints)).not.toMatch(/supportingEvidenceIds|acknowledgedBy|USR-/);
    // another insurer and another facility see nothing
    expect(
      (await w.api("GET", "/insurance/v1/interventions", OTHER_INSURER)).body.interventions,
    ).toEqual([]);
    expect((await w.api("GET", "/insurance/v1/sites", OTHER_INSURER)).body.sites).toEqual([]);
    expect((await w.api("GET", "/insurance/v1/sites/FAC-NOPE/cases", RE)).status).toBe(403);
  });

  it("an insurer sees a faithful result for every outcome, never an upgraded one", async () => {
    const w = await makeWorld();
    const caseId = await w.detect();
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("compound-outdoor-heat", 25);
    await w.runtime.tick();
    await w.grant(MGR);
    const ev = await evidence(w, caseId);
    expect(ev.body.verification).toMatchObject({
      result: "NOT_IMPROVING",
      resultLabel: "NOT IMPROVING",
    });
    expect(JSON.stringify(ev.body)).not.toMatch(/VERIFIED IMPROVED/);
    expect(ev.body.recommendation.caseState).toBe("NOT_IMPROVING");
    expect(ev.body.verification.interpretation).not.toMatch(/met every required criterion/);
    // a later successful cycle adds a package; the history keeps both, results unchanged
    await w.reportAction(caseId, undefined, true);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const latest = await evidence(w, caseId);
    expect(latest.body.verification.result).toBe("VERIFIED");
    expect(latest.body.packageHistory.map((p: Json) => p.result)).toEqual([
      "NOT_IMPROVING",
      "VERIFIED",
    ]);
    const firstId = latest.body.packageHistory[0].packageId as string;
    const old = await evidence(w, caseId, RE, `?package=${firstId}`);
    expect(old.body.verification.result).toBe("NOT_IMPROVING");
    expect(old.body.evidencePackage.packageId).toBe(firstId);
    expect((await evidence(w, caseId, RE, "?package=EVP-NOPE")).status).toBe(404);
    expect((await evidence(w, caseId, RE, "?package=bad%20id")).status).toBe(400);
  });

  it("an existing agreement releases the new package after a recurrence cycle, but each read is still authorized", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const g = await w.grant(MGR);
    const id = g.body.agreement.agreementId as string;
    const first = await w.latestPackage(caseId);
    // the hazard returns, is handled and verified again
    await w.send("normal", 12);
    await w.send("compound-outdoor-heat", 3);
    const mid = await evidence(w, caseId);
    expect(mid.body.recurrence).toMatchObject({
      reopenedSincePackage: true,
      currentRecurrenceCount: 1,
    });
    expect(mid.body.evidencePackage.packageId).toBe(first?.packageId);
    await w.reportAction(caseId);
    await w.runtime.tick();
    await w.send("normal", 25);
    await w.runtime.tick();
    const second = await w.latestPackage(caseId);
    expect(second?.packageId).not.toBe(first?.packageId);
    expect(await state(w, caseId)).toBe("SHARED");
    const shared = w.runtime.bus.history().filter((e) => e.event_type === "evidence.shared.v1");
    expect(shared.map((e) => (e.payload as Json).evidencePackageId)).toEqual([
      first?.packageId,
      second?.packageId,
    ]);
    expect((await evidence(w, caseId)).body.evidencePackage.packageId).toBe(second?.packageId);
    // revocation applies to the new package and the old one alike
    w.clock.advance(1000);
    await w.api("POST", `/api/v1/sharing-agreements/${id}/revoke`, MGR, {});
    expect((await evidence(w, caseId)).status).toBe(403);
    expect((await evidence(w, caseId, RE, `?package=${first?.packageId}`)).status).toBe(403);
    expect(await state(w, caseId)).toBe("REVOKED");
  });
});

describe("C5 the minimal evidence and sharing pages", () => {
  it("shows the package, hash status, label and sharing state, and lets the facility grant and revoke", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const pkg = await w.latestPackage(caseId);
    let page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(pkg?.packageId);
    expect(page.text).toContain("VERIFIED IMPROVED");
    expect(page.text).toContain("VPOL-COOLING-ELECTRICAL");
    expect(page.text).toContain(pkg?.payloadSha256);
    expect(page.text).toContain("VALID (recomputed now)");
    expect(page.text).toContain("SYNTHETIC DATA");
    expect(page.text).toContain("SHAREABLE");
    expect(page.text).toContain("Grant sharing");
    expect(page.text).toContain("RAW_TELEMETRY is off");
    expect(page.text).not.toMatch(/<script/i);

    const grant = await w.html(`/ui/sharing/grant?actor=${MGR}&case=${caseId}`, {
      method: "POST",
      form: {
        recipientOrganizationId: "ORG-INS-001",
        facilityId: FAC,
        scope: ["VERIFICATION_RESULT", "RECOMMENDATION"],
      },
    });
    expect(grant.status).toBe(303);
    expect(grant.location).toBe(`/ui/cases/${caseId}?actor=${MGR}`);
    const [agreement] = await w.runtime.agreements.listForOwner(ORG);
    expect(agreement).toMatchObject({
      createdBy: MGR,
      scopes: ["RECOMMENDATION", "VERIFICATION_RESULT"],
    });
    page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.text).toContain("SHARED");
    expect(page.text).toContain(agreement?.agreementId);

    // the insurer page shows only the consented sections
    const insurerHome = await w.html(`/ui/insurer/cases?actor=${RE}`);
    expect(insurerHome.text).toContain(caseId);
    const insurerCase = await w.html(`/ui/insurer/cases/${caseId}?actor=${RE}`);
    expect(insurerCase.status).toBe(200);
    expect(insurerCase.text).toContain("Verification result");
    expect(insurerCase.text).toContain("VERIFIED IMPROVED");
    expect(insurerCase.text).toContain("SYNTHETIC DATA");
    expect(insurerCase.text).not.toContain("Before and after");
    expect(insurerCase.text).not.toContain("Action summary");

    w.clock.advance(1000);
    const revoke = await w.html(
      `/ui/sharing/${agreement?.agreementId}/revoke?actor=${MGR}&case=${caseId}`,
      { method: "POST", form: {} },
    );
    expect(revoke.status).toBe(303);
    expect(
      (await w.runtime.agreements.getForOwner(ORG, agreement?.agreementId ?? ""))?.revokedAt,
    ).toBeDefined();
    page = await w.html(`/ui/cases/${caseId}?actor=${MGR}`);
    expect(page.text).toContain("REVOKED");
    const denied = await w.html(`/ui/insurer/cases/${caseId}?actor=${RE}`);
    expect(denied.status).toBe(403);
    expect(denied.text).toContain("AGREEMENT_REVOKED");
    expect(denied.text).not.toContain("Verification result");
  });

  it("form posts obey the same rules: no raw telemetry for a manager, no posting as insurer or other tenant", async () => {
    const w = await makeWorld();
    const caseId = await w.verified();
    const post = (actor: string, scope: string[]) =>
      w.html(`/ui/sharing/grant?actor=${actor}&case=${caseId}`, {
        method: "POST",
        form: { recipientOrganizationId: "ORG-INS-001", facilityId: FAC, scope },
      });
    expect((await post(MGR, ["RAW_TELEMETRY"])).status).toBe(403);
    expect((await post(RE, ["RECOMMENDATION"])).status).toBe(403);
    expect((await post(OTHER_ORG_MGR, ["RECOMMENDATION"])).status).toBe(400);
    expect((await post(MGR, [])).status).toBe(400);
    expect(await w.runtime.agreements.listForOwner(ORG)).toEqual([]);
    expect(
      (await w.html(`/ui/sharing/grant?actor=${MGR}`, { method: "POST", form: {} })).status,
    ).toBe(400);
    expect(
      (await w.html(`/ui/cases/${caseId}?actor=${MGR}`, { method: "POST", form: {} })).status,
    ).toBe(405);
    const operatorPage = await w.html(`/ui/cases/${caseId}?actor=${OPERATOR}`);
    expect(operatorPage.text).toContain("not available to this role");
    expect(operatorPage.text).not.toContain("Grant sharing");
  });
});
