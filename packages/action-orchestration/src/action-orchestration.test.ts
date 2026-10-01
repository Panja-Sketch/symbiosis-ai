import { describe, expect, it } from "vitest";
import type { MitigationAction } from "@symbiosis/contracts";
import { ACTION_STATUSES } from "@symbiosis/contracts";
import { ACTION_TRANSITIONS, applyActionCommand, assignMitigationAction } from "./actions";

const T1 = "2026-01-02T00:00:00Z";
const T2 = "2026-01-02T01:00:00Z";

function assigned(): MitigationAction {
  const r = assignMitigationAction({
    actionId: "ACT-1",
    caseId: "CASE-1",
    eventId: "EVT-1",
    actionLibraryId: "RA-1",
    assignedTo: "U-1",
  });
  if (!r.ok) throw new Error("fixture invalid");
  return r.value;
}

describe("mitigation action", () => {
  it("assigns an action in ASSIGNED status with no report data", () => {
    const a = assigned();
    expect(a.status).toBe("ASSIGNED");
    expect(a.reportedBy).toBeUndefined();
    expect(a.reportedAt).toBeUndefined();
  });

  it("rejects invalid assignment input", () => {
    const r = assignMitigationAction({
      actionId: "",
      caseId: "C",
      eventId: "E",
      actionLibraryId: "RA",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });

  it("acknowledges an assigned action", () => {
    const r = applyActionCommand(assigned(), { type: "ACKNOWLEDGE", at: T1, actorId: "U-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value.status).toBe("ACKNOWLEDGED");
      expect(r.value.record).toMatchObject({
        from: "ASSIGNED",
        to: "ACKNOWLEDGED",
        actorId: "U-1",
      });
    }
  });

  it("records a reported completion with reporter, time, notes and attachments", () => {
    const ack = applyActionCommand(assigned(), { type: "ACKNOWLEDGE", at: T1, actorId: "U-1" });
    if (!ack.ok) throw new Error("setup");
    const r = applyActionCommand(ack.value.value, {
      type: "REPORT_COMPLETE",
      at: T2,
      reportedBy: "U-1",
      notes: "Started backup fan",
      attachments: ["ATT-1"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.value).toMatchObject({
        status: "REPORTED_COMPLETE",
        reportedBy: "U-1",
        reportedAt: T2,
        notes: "Started backup fan",
        attachments: ["ATT-1"],
      });
    }
  });

  it("reported completion carries no verification: the type has no verification fields", () => {
    const r = applyActionCommand(assigned(), {
      type: "REPORT_COMPLETE",
      at: T1,
      reportedBy: "U-1",
    });
    if (!r.ok) throw new Error("setup");
    const keys = Object.keys(r.value.value);
    expect(keys.some((k) => /verif/i.test(k))).toBe(false);
    expect(ACTION_STATUSES).not.toContain("VERIFIED");
  });

  it("rejects illegal transitions with ILLEGAL_ACTION_TRANSITION", () => {
    const done = applyActionCommand(assigned(), {
      type: "REPORT_COMPLETE",
      at: T1,
      reportedBy: "U-1",
    });
    if (!done.ok) throw new Error("setup");
    const again = applyActionCommand(done.value.value, {
      type: "ACKNOWLEDGE",
      at: T2,
      actorId: "U-1",
    });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("ILLEGAL_ACTION_TRANSITION");
    expect(ACTION_TRANSITIONS.REPORTED_COMPLETE).toEqual([]);
  });

  it("requires an actor and a valid timestamp", () => {
    expect(applyActionCommand(assigned(), { type: "ACKNOWLEDGE", at: T1, actorId: "" }).ok).toBe(
      false,
    );
    expect(
      applyActionCommand(assigned(), { type: "ACKNOWLEDGE", at: "yesterday", actorId: "U" }).ok,
    ).toBe(false);
  });

  it("is deterministic and does not mutate its input", () => {
    const a = assigned();
    const cmd = { type: "ACKNOWLEDGE", at: T1, actorId: "U-1" } as const;
    expect(applyActionCommand(a, cmd)).toEqual(applyActionCommand(a, cmd));
    expect(a.status).toBe("ASSIGNED");
  });
});
