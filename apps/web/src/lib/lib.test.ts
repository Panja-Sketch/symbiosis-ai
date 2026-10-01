import { describe, expect, it } from "vitest";
import { formatTime, formatValue, humanizeCode } from "./format";
import { homeFor, landingFor, personaOf, safeLocalPath } from "./identity";
import {
  INTERVENTION_INFO,
  INTERVENTION_ORDER,
  STATUS,
  STATUS_FOR_STATE,
  detectionReason,
  interventionReason,
} from "./labels";
import { param } from "./summary";

describe("web helpers", () => {
  it("persona is a navigation grouping from permissions", () => {
    expect(personaOf({ permissions: ["INSURANCE_EVIDENCE_READ"] })).toBe("INSURER");
    expect(personaOf({ permissions: ["CASE_READ"] })).toBe("FACILITY");
    expect(homeFor("INSURER")).toBe("/risk-evidence");
  });
  it("landing keeps a colleague on the same area and otherwise goes home", () => {
    expect(landingFor("FACILITY", "/operations/cases/C1?notice=x#feedback")).toBe(
      "/operations/cases/C1",
    );
    expect(landingFor("INSURER", "/operations/cases/C1")).toBe("/risk-evidence");
    expect(landingFor("FACILITY", undefined)).toBe("/operations");
    expect(landingFor("INSURER", "/trust")).toBe("/trust");
  });
  it("returnTo must be a same-site path", () => {
    expect(safeLocalPath("//evil.example")).toBeUndefined();
    expect(safeLocalPath("https://evil.example")).toBeUndefined();
    expect(safeLocalPath("/operations/cases/C-1")).toBe("/operations/cases/C-1");
  });
  it("every case state has an icon-and-label status", () => {
    for (const key of Object.values(STATUS_FOR_STATE)) {
      expect(STATUS[key].label.length).toBeGreaterThan(0);
      expect(STATUS[key].icon.length).toBeGreaterThan(0);
    }
    expect(Object.keys(STATUS_FOR_STATE)).toHaveLength(10);
  });
  it("intervention levels have fixed wording that never implies dispatch", () => {
    expect(INTERVENTION_ORDER.map((l) => INTERVENTION_INFO[l].label)).toEqual([
      "Remote Monitoring",
      "Remote Review",
      "Risk Engineer Review",
      "Site Visit Recommended",
    ]);
    for (const l of INTERVENTION_ORDER) {
      expect(INTERVENTION_INFO[l].meaning).not.toMatch(/dispatched|has been scheduled/i);
    }
  });
  it("reason codes translate deterministically with a readable fallback", () => {
    expect(detectionReason("PERSISTED_3_OF_3")).toBe("Persisted for 3 of 3 required checks");
    expect(detectionReason("NEW_CODE")).toBe("new code");
    expect(interventionReason("RECURRED_AFTER_VERIFIED_IMPROVEMENT")).toContain("returned");
    expect(humanizeCode("A_B")).toBe("a b");
  });
  it("formatting is stable and does not invent precision", () => {
    expect(formatTime("2026-10-01T00:04:25.000Z")).toBe("1 Oct 2026, 00:04 UTC");
    expect(formatTime(undefined)).toBe("—");
    expect(formatValue(0.19823456)).toBe("0.1982");
    expect(formatValue(0)).toBe("0");
  });
  it("query params: empty, repeated and ALL mean no filter", () => {
    expect(param("ALL")).toBeUndefined();
    expect(param("")).toBeUndefined();
    expect(param(["OPEN", "x"])).toBe("OPEN");
  });
});
