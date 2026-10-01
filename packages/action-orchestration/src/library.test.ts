import { describe, expect, it } from "vitest";
import { actionsFor, findAction, parseActionLibrary } from "./library";
import { library } from "./world.fixture";
import { buildCaseView } from "./view";
import type { MitigationAction, RiskImprovementCase } from "@symbiosis/contracts";

describe("approved action library (versioned config)", () => {
  it("has stable, prefixed, unique IDs and a version", () => {
    expect(library.version).toBe("cooling-actions.v1");
    const ids = library.actions.map((a) => a.actionLibraryId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^ACT-COOLING-[A-Z-]+$/);
    expect(ids).toEqual(
      expect.arrayContaining([
        "ACT-COOLING-INSPECT-PRIMARY",
        "ACT-COOLING-START-BACKUP",
        "ACT-COOLING-REDUCE-LOAD",
      ]),
    );
  });

  it("is RECOMMEND_ONLY: no entry controls equipment", () => {
    for (const a of library.actions) expect(a.controlsEquipment).toBe(false);
  });

  it("rejects an entry that claims to control equipment, or malformed entries", () => {
    const bad = (over: object) =>
      parseActionLibrary({
        version: "v",
        actions: [
          {
            actionLibraryId: "ACT-X-Y",
            title: "t",
            description: "d",
            hazardTypes: ["H"],
            controlsEquipment: false,
            ...over,
          },
        ],
      });
    expect(() => bad({})).not.toThrow();
    expect(() => bad({ controlsEquipment: true })).toThrow(/RECOMMEND_ONLY/);
    expect(() => bad({ controlsEquipment: undefined })).toThrow();
    expect(() => bad({ actionLibraryId: "start the fan" })).toThrow();
    expect(() => bad({ hazardTypes: [] })).toThrow();
    expect(() => bad({ title: " " })).toThrow();
    expect(() => parseActionLibrary({ version: "v", actions: [{}, {}] })).toThrow();
    expect(() => parseActionLibrary(null)).toThrow();
  });

  it("rejects duplicate IDs", () => {
    const entry = {
      actionLibraryId: "ACT-A",
      title: "t",
      description: "d",
      hazardTypes: ["H"],
      controlsEquipment: false,
    };
    expect(() => parseActionLibrary({ version: "v", actions: [entry, entry] })).toThrow();
  });

  it("looks up by ID and by applicable hazard", () => {
    expect(findAction(library, "ACT-COOLING-START-BACKUP")?.title).toMatch(/backup/i);
    expect(findAction(library, "ACT-NOPE")).toBeUndefined();
    expect(actionsFor(library, "COOLING_ELECTRICAL_DETERIORATION")).toHaveLength(4);
    expect(actionsFor(library, "SOMETHING_ELSE")).toEqual([]);
  });

  it("wording never instructs the platform to operate equipment", () => {
    for (const a of library.actions) {
      expect(a.description).not.toMatch(/\bautomatically\b|\bremotely\b/i);
    }
  });
});

describe("buildCaseView presentation rules", () => {
  const base: RiskImprovementCase = {
    caseId: "C",
    organizationId: "O",
    facilityId: "F",
    assetIds: ["A"],
    origin: { type: "DETECTED_HAZARD", detectionId: "D" },
    hazardType: "COOLING_ELECTRICAL_DETERIORATION",
    title: "t",
    severity: "HIGH",
    state: "OPEN",
    recurrenceCount: 0,
    sharingState: "NOT_SHARED",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  const view = (state: RiskImprovementCase["state"], actions: MitigationAction[] = []) =>
    buildCaseView({ caseRecord: { ...base, state }, actions, alerts: [], audit: [], library });

  it("shows VERIFICATION PENDING only for ACTION_REPORTED", () => {
    expect(view("ACTION_REPORTED").didItWork).toMatchObject({
      status: "VERIFICATION_PENDING",
      label: "VERIFICATION PENDING",
    });
    for (const s of ["OPEN", "ACTION_REQUIRED", "REOPENED"] as const) {
      expect(view(s).didItWork.status).toBe("NOT_APPLICABLE_YET");
    }
  });

  it("never renders the word VERIFIED for any state, even states S4 cannot produce", () => {
    for (const s of [
      "OPEN",
      "ACTION_REQUIRED",
      "ACTION_REPORTED",
      "VERIFYING",
      "VERIFIED_IMPROVED",
      "PARTIALLY_VERIFIED",
      "NOT_IMPROVING",
      "INCONCLUSIVE",
      "CLOSED",
      "REOPENED",
    ] as const) {
      const v = view(s);
      expect(JSON.stringify(v.didItWork), s).not.toMatch(/VERIFIED/i);
      expect(v.didItWork.label, s).not.toMatch(/VERIFIED/i);
    }
  });

  it("marks reported approved actions and keeps others available", () => {
    const reported: MitigationAction = {
      actionId: "ACT-1",
      caseId: "C",
      eventId: "E",
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assignedTo: "U",
      reportedBy: "U",
      reportedAt: "2026-10-01T00:01:00.000Z",
      status: "REPORTED_COMPLETE",
    };
    const v = view("ACTION_REPORTED", [reported]);
    const status = Object.fromEntries(
      v.whatToDo.approvedActions.map((a) => [a.actionLibraryId, a.status]),
    );
    expect(status["ACT-COOLING-INSPECT-PRIMARY"]).toBe("REPORTED");
    expect(status["ACT-COOLING-START-BACKUP"]).toBe("AVAILABLE");
    expect(v.whatWasDone.actions[0]).toMatchObject({ actionId: "ACT-1", reportedBy: "U" });
  });

  it("an empty audit trail yields no detections and an unrequested alert", () => {
    const v = view("OPEN");
    expect(v.detectionCount).toBe(0);
    expect(v.accountability.alert.status).toBe("NOT_REQUESTED");
    expect(v.accountability.acknowledgement.acknowledged).toBe(false);
    expect(v.accountability.escalation.escalated).toBe(false);
  });
});
