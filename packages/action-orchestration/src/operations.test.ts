import { describe, expect, it } from "vitest";
import { ADMIN, AUDITOR, MGR, OPERATOR, OTHER_ORG_MGR, actor, makeWorld } from "./world.fixture";
import type { World } from "./world.fixture";

const types = (w: World) => w.bus.history().map((e) => e.event_type as string);
const ACK = [
  { type: "ALERT", at: "2026-10-01T00:05:00.000Z" },
  { type: "ACKNOWLEDGE", at: "2026-10-01T00:06:00.000Z", actorId: MGR },
] as const;

async function acknowledged() {
  const w = await makeWorld([...ACK]);
  return w;
}

describe("acknowledgement", () => {
  it("acknowledges an alerted risk, audits it and publishes risk.acknowledged", async () => {
    const w = await makeWorld();
    const r = await w.operations.acknowledgeCase(await actor(w, MGR), "CASE-1", "on my way");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ riskEventState: "ACKNOWLEDGED", caseState: "OPEN" });
    expect((await w.riskEvents.get("ORG-SIM-001", "RE-1"))?.state).toBe("ACKNOWLEDGED");
    const e = w.bus.history().find((x) => x.event_type === "risk.acknowledged.v1");
    expect(e?.event_type === "risk.acknowledged.v1" && e.payload).toMatchObject({
      caseId: "CASE-1",
      riskEventId: "RE-1",
      actorId: MGR,
      note: "on my way",
    });
    const entries = await w.audit.listByCase("ORG-SIM-001", "CASE-1");
    expect(entries.at(-1)).toMatchObject({
      action: "RISK_ACKNOWLEDGED",
      actorId: MGR,
      actorType: "USER",
      beforeState: "ALERTED",
      afterState: "ACKNOWLEDGED",
    });
  });

  it("does not mean action was taken or risk improved: case, actions and verification are untouched", async () => {
    const w = await makeWorld();
    const before = await w.cases.get("ORG-SIM-001", "CASE-1");
    await w.operations.acknowledgeCase(await actor(w, MGR), "CASE-1");
    expect(await w.cases.get("ORG-SIM-001", "CASE-1")).toEqual(before);
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
    expect(
      types(w).filter((t) => t.startsWith("verification") || t === "action.reported.v1"),
    ).toEqual([]);
    const view = await w.operations.getCaseView(await actor(w, MGR), "CASE-1");
    expect(view.ok && view.value.didItWork.label).toBe("NO ACTION REPORTED YET");
  });

  it("an operator may acknowledge; escalated risks can still be acknowledged", async () => {
    const w = await makeWorld([
      { type: "ALERT", at: "2026-10-01T00:05:00.000Z" },
      { type: "ESCALATE", at: "2026-10-01T00:08:00.000Z" },
    ]);
    const r = await w.operations.acknowledgeCase(await actor(w, OPERATOR), "CASE-1");
    expect(r.ok && r.value.riskEventState).toBe("ACKNOWLEDGED");
  });

  it("explicitly rejects a duplicate acknowledgement (409-style CONFLICT) and changes nothing", async () => {
    const w = await makeWorld();
    const a = await actor(w, MGR);
    await w.operations.acknowledgeCase(a, "CASE-1");
    const before = (await w.audit.list("ORG-SIM-001")).length;
    const again = await w.operations.acknowledgeCase(a, "CASE-1");
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("CONFLICT");
      expect(again.error.domain?.code).toBe("ILLEGAL_LIFECYCLE_TRANSITION");
    }
    expect((await w.audit.list("ORG-SIM-001")).length).toBe(before);
  });

  it("rejects acknowledgement when the risk was never alerted (event still DETECTED)", async () => {
    const w = await makeWorld([]);
    const r = await w.operations.acknowledgeCase(await actor(w, MGR), "CASE-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });

  it("rejects a case with no active risk event", async () => {
    const w = await makeWorld();
    const c = await w.cases.get("ORG-SIM-001", "CASE-1");
    const without: Record<string, unknown> = { ...c };
    delete without.activeRiskEventId;
    await w.cases.save(without as never);
    const r = await w.operations.acknowledgeCase(await actor(w, MGR), "CASE-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });

  it("requires the permission: a read-only auditor cannot acknowledge", async () => {
    const w = await makeWorld();
    const r = await w.operations.acknowledgeCase(await actor(w, AUDITOR), "CASE-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
  });

  it("validates the note", async () => {
    const w = await makeWorld();
    const r = await w.operations.acknowledgeCase(await actor(w, MGR), "CASE-1", "x".repeat(501));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
  });
});

describe("assignment and action acknowledgement", () => {
  it("assigns an approved action: creates it, moves the case to ACTION_REQUIRED, sets the owner", async () => {
    const w = await acknowledged();
    const r = await w.operations.assignAction(await actor(w, MGR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ caseState: "ACTION_REQUIRED", riskEventState: "ACKNOWLEDGED" });
    const action = await w.actions.get("ORG-SIM-001", r.value.actionId as string);
    expect(action).toMatchObject({
      status: "ASSIGNED",
      caseId: "CASE-1",
      eventId: "RE-1",
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionLibraryVersion: "cooling-actions.v1",
      assignedTo: OPERATOR,
      assignedBy: MGR,
    });
    expect(action?.assignedAt).toBeDefined();
    expect((await w.cases.get("ORG-SIM-001", "CASE-1"))?.assignedOwnerId).toBe(OPERATOR);
    expect(types(w)).toEqual(expect.arrayContaining(["action.assigned.v1", "case.updated.v1"]));
    const audit = await w.audit.listByCase("ORG-SIM-001", "CASE-1");
    expect(audit.at(-1)).toMatchObject({ action: "ACTION_ASSIGNED", targetType: "ACTION" });
  });

  it("assigning a second action keeps the case in ACTION_REQUIRED", async () => {
    const w = await acknowledged();
    const m = await actor(w, MGR);
    await w.operations.assignAction(m, "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    const second = await w.operations.assignAction(m, "CASE-1", {
      actionLibraryId: "ACT-COOLING-START-BACKUP",
      assigneeId: MGR,
    });
    expect(second.ok && second.value.caseState).toBe("ACTION_REQUIRED");
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toHaveLength(2);
  });

  it.each(["", "ACT-NOT-APPROVED", "inspect the fan", "ACT-COOLING-RUN-DIAGNOSTICS"])(
    "rejects an unapproved action ID %j",
    async (id) => {
      const w = await acknowledged();
      const r = await w.operations.assignAction(await actor(w, MGR), "CASE-1", {
        actionLibraryId: id,
        assigneeId: OPERATOR,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
      expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
    },
  );

  it("rejects an assignee outside the organization or facility (without revealing which)", async () => {
    const w = await acknowledged();
    const m = await actor(w, MGR);
    for (const assigneeId of [OTHER_ORG_MGR, "USR-NOBODY", ""]) {
      const r = await w.operations.assignAction(m, "CASE-1", {
        actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
        assigneeId,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    }
  });

  it("requires acknowledgement first, and the assign permission", async () => {
    const w = await makeWorld();
    const early = await w.operations.assignAction(await actor(w, MGR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe("CONFLICT");
    const w2 = await acknowledged();
    const op = await w2.operations.assignAction(await actor(w2, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    expect(op.ok).toBe(false);
    if (!op.ok) expect(op.error.code).toBe("FORBIDDEN");
  });

  it("only the assignee can acknowledge an action, and it changes no physical conclusion", async () => {
    const w = await acknowledged();
    const assigned = await w.operations.assignAction(await actor(w, MGR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    const actionId = assigned.ok ? (assigned.value.actionId as string) : "";
    const wrong = await w.operations.acknowledgeAction(await actor(w, MGR), "CASE-1", actionId);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("FORBIDDEN");
    const caseBefore = await w.cases.get("ORG-SIM-001", "CASE-1");
    const eventBefore = await w.riskEvents.get("ORG-SIM-001", "RE-1");
    const ok = await w.operations.acknowledgeAction(await actor(w, OPERATOR), "CASE-1", actionId);
    expect(ok.ok).toBe(true);
    expect(await w.actions.get("ORG-SIM-001", actionId)).toMatchObject({
      status: "ACKNOWLEDGED",
      acknowledgedBy: OPERATOR,
    });
    expect(await w.cases.get("ORG-SIM-001", "CASE-1")).toEqual(caseBefore);
    expect(await w.riskEvents.get("ORG-SIM-001", "RE-1")).toEqual(eventBefore);
    expect(types(w)).toContain("action.acknowledged.v1");
    const again = await w.operations.acknowledgeAction(
      await actor(w, OPERATOR),
      "CASE-1",
      actionId,
    );
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("CONFLICT");
  });

  it("an action of another case is not found", async () => {
    const w = await acknowledged();
    const r = await w.operations.acknowledgeAction(await actor(w, OPERATOR), "CASE-1", "ACT-GHOST");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
  });
});

describe("reporting an action", () => {
  async function assigned() {
    const w = await acknowledged();
    const a = await w.operations.assignAction(await actor(w, MGR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      assigneeId: OPERATOR,
    });
    return { w, actionId: a.ok ? (a.value.actionId as string) : "" };
  }

  it("moves action, event and case to reported states together, with actor, time, notes and attachment IDs", async () => {
    const { w, actionId } = await assigned();
    const r = await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
      notes: "Bearing noise found; lubricated.",
      attachments: ["ATT-1", "ATT-2"],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      caseState: "ACTION_REPORTED",
      riskEventState: "ACTION_REPORTED",
      actionId,
    });
    expect(await w.actions.get("ORG-SIM-001", actionId)).toMatchObject({
      status: "REPORTED_COMPLETE",
      reportedBy: OPERATOR,
      notes: "Bearing noise found; lubricated.",
      attachments: ["ATT-1", "ATT-2"],
    });
    expect((await w.actions.get("ORG-SIM-001", actionId))?.reportedAt).toBeDefined();
    const ev = w.bus.history().find((e) => e.event_type === "action.reported.v1");
    expect(ev?.event_type === "action.reported.v1" && ev.payload).toMatchObject({
      attachmentCount: 2,
      hasNotes: true,
    });
    expect(types(w).slice(-2)).toEqual(["action.reported.v1", "case.updated.v1"]);
  });

  it("REPORTED_COMPLETE NEVER produces a verified state, a verification result or a verification event", async () => {
    const { w, actionId } = await assigned();
    await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
    });
    const c = await w.cases.get("ORG-SIM-001", "CASE-1");
    const e = await w.riskEvents.get("ORG-SIM-001", "RE-1");
    expect(c?.state).toBe("ACTION_REPORTED");
    expect(c?.state).not.toBe("VERIFIED_IMPROVED");
    expect(c?.latestVerificationId).toBeUndefined();
    expect(e?.state).toBe("ACTION_REPORTED");
    expect(e?.latestVerificationId).toBeUndefined();
    expect(types(w).some((t) => t.startsWith("verification"))).toBe(false);
    const view = await w.operations.getCaseView(await actor(w, MGR), "CASE-1");
    expect(view.ok && view.value.didItWork).toMatchObject({
      status: "VERIFICATION_PENDING",
      label: "VERIFICATION PENDING",
    });
    expect(JSON.stringify(view)).not.toMatch(/VERIFIED/i);
  });

  it("can report without prior assignment (the action is created for the reporter)", async () => {
    const w = await acknowledged();
    const r = await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-START-BACKUP",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      caseState: "ACTION_REPORTED",
      riskEventState: "ACTION_REPORTED",
    });
    expect(await w.actions.get("ORG-SIM-001", r.value.actionId as string)).toMatchObject({
      assignedTo: OPERATOR,
      status: "REPORTED_COMPLETE",
    });
  });

  it("rejects an unapproved action, notes that are too long, and bad attachment references", async () => {
    const w = await acknowledged();
    const o = await actor(w, OPERATOR);
    const bad = [
      { actionLibraryId: "ACT-FREEFORM-DO-ANYTHING" },
      { actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY", notes: "n".repeat(2001) },
      { actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY", attachments: Array(11).fill("A") },
      {
        actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
        attachments: [{ blob: "AAAA" }] as unknown as string[],
      },
      { actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY", attachments: [""] },
    ];
    for (const input of bad) {
      const r = await w.operations.reportAction(o, "CASE-1", input);
      expect(r.ok, JSON.stringify(input).slice(0, 60)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_REQUEST");
    }
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
    expect((await w.riskEvents.get("ORG-SIM-001", "RE-1"))?.state).toBe("ACKNOWLEDGED");
  });

  it("rejects an action of another case/event and a library ID that does not match", async () => {
    const { w, actionId } = await assigned();
    const o = await actor(w, OPERATOR);
    const ghost = await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId: "ACT-GHOST",
    });
    expect(ghost.ok).toBe(false);
    if (!ghost.ok) expect(ghost.error.code).toBe("NOT_FOUND");
    const mismatch = await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-START-BACKUP",
      actionId,
    });
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.error.code).toBe("INVALID_REQUEST");
  });

  it("deterministically rejects reporting the same action twice", async () => {
    const { w, actionId } = await assigned();
    const o = await actor(w, OPERATOR);
    const first = await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
    });
    expect(first.ok).toBe(true);
    const audit = (await w.audit.list("ORG-SIM-001")).length;
    const second = await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("CONFLICT");
      expect(second.error.domain?.code).toBe("ILLEGAL_ACTION_TRANSITION");
    }
    expect((await w.audit.list("ORG-SIM-001")).length).toBe(audit);
  });

  it("a different approved action may be reported while waiting in ACTION_REPORTED (state unchanged)", async () => {
    const { w, actionId } = await assigned();
    const o = await actor(w, OPERATOR);
    await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      actionId,
    });
    const updatesBefore = types(w).filter((t) => t === "case.updated.v1").length;
    const second = await w.operations.reportAction(o, "CASE-1", {
      actionLibraryId: "ACT-COOLING-START-BACKUP",
    });
    expect(second.ok && second.value).toMatchObject({
      caseState: "ACTION_REPORTED",
      riskEventState: "ACTION_REPORTED",
    });
    expect(types(w).filter((t) => t === "case.updated.v1").length).toBe(updatesBefore); // no state change
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toHaveLength(2);
  });

  it("requires acknowledgement first: an alerted-only event rejects a report", async () => {
    const w = await makeWorld();
    const r = await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
  });

  it("is all-or-nothing: if the case cannot accept the report, the action and event stay as they were", async () => {
    const w = await acknowledged();
    const c = await w.cases.get("ORG-SIM-001", "CASE-1");
    await w.cases.save({ ...c!, state: "CLOSED" }); // inconsistent on purpose: closed case, live event
    const before = await w.riskEvents.get("ORG-SIM-001", "RE-1");
    const r = await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
    });
    expect(r.ok).toBe(false);
    expect(await w.riskEvents.get("ORG-SIM-001", "RE-1")).toEqual(before);
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
    expect(types(w).filter((t) => t.startsWith("action."))).toEqual([]);
    expect((await w.audit.list("ORG-SIM-001")).length).toBe(0);
  });
});

describe("dismissal seam (local application authorization)", () => {
  it("needs a reason and the permission; then closes the case administratively, not as verified", async () => {
    const w = await makeWorld();
    const noReason = await w.operations.dismissCase(await actor(w, MGR), "CASE-1", " ");
    expect(noReason.ok).toBe(false);
    const operator = await w.operations.dismissCase(
      await actor(w, OPERATOR),
      "CASE-1",
      "false alarm",
    );
    expect(operator.ok).toBe(false);
    if (!operator.ok) expect(operator.error.code).toBe("FORBIDDEN");
    const r = await w.operations.dismissCase(
      await actor(w, MGR),
      "CASE-1",
      "Sensor was being calibrated",
    );
    expect(r.ok && r.value).toMatchObject({
      caseState: "CLOSED",
      riskEventState: "DISMISSED_FALSE_ALARM",
    });
    expect((await w.cases.get("ORG-SIM-001", "CASE-1"))?.latestVerificationId).toBeUndefined();
    expect(types(w)).toEqual(expect.arrayContaining(["risk.dismissed.v1", "case.updated.v1"]));
    expect((await w.audit.list("ORG-SIM-001")).at(-1)).toMatchObject({
      action: "RISK_DISMISSED",
      actorId: MGR,
    });
  });

  it("cannot dismiss a risk that already has a reported action", async () => {
    const w = await acknowledged();
    await w.operations.reportAction(await actor(w, OPERATOR), "CASE-1", {
      actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
    });
    const r = await w.operations.dismissCase(await actor(w, ADMIN), "CASE-1", "changed my mind");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CONFLICT");
  });
});

describe("tenancy and permissions", () => {
  it("another organization's actor cannot read, acknowledge, assign, report or dismiss (indistinguishable from not found)", async () => {
    const w = await acknowledged();
    const stranger = await actor(w, OTHER_ORG_MGR);
    const results = await Promise.all([
      w.operations.getCaseView(stranger, "CASE-1"),
      w.operations.acknowledgeCase(stranger, "CASE-1"),
      w.operations.assignAction(stranger, "CASE-1", {
        actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
        assigneeId: OTHER_ORG_MGR,
      }),
      w.operations.reportAction(stranger, "CASE-1", {
        actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
      }),
      w.operations.acknowledgeAction(stranger, "CASE-1", "ACT-1"),
      w.operations.dismissCase(stranger, "CASE-1", "x"),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    }
    expect((await w.riskEvents.get("ORG-SIM-001", "RE-1"))?.state).toBe("ACKNOWLEDGED");
    expect(await w.actions.listByCase("ORG-SIM-001", "CASE-1")).toEqual([]);
  });

  it("guessing the case ID with another organization's scope returns nothing", async () => {
    const w = await acknowledged();
    expect(await w.cases.get("ORG-SIM-002", "CASE-1")).toBeUndefined();
    const list = await w.operations.listCases(await actor(w, OTHER_ORG_MGR));
    expect(list.ok && list.value).toEqual([]);
  });

  it("an actor limited to other facilities cannot see the case", async () => {
    const w = await acknowledged();
    const scoped = { ...(await actor(w, MGR)), facilityIds: ["FAC-ELSEWHERE"] };
    const r = await w.operations.getCaseView(scoped, "CASE-1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    const list = await w.operations.listCases(scoped);
    expect(list.ok && list.value).toEqual([]);
  });

  it("read access: auditor can read but not act", async () => {
    const w = await acknowledged();
    const a = await actor(w, AUDITOR);
    expect((await w.operations.getCaseView(a, "CASE-1")).ok).toBe(true);
    expect(
      (
        await w.operations.reportAction(a, "CASE-1", {
          actionLibraryId: "ACT-COOLING-INSPECT-PRIMARY",
        })
      ).ok,
    ).toBe(false);
  });
});

describe("case view", () => {
  it("lists the approved actions as RECOMMEND_ONLY and shows sharing as not yet available", async () => {
    const w = await acknowledged();
    const v = await w.operations.getCaseView(await actor(w, MGR), "CASE-1");
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.whatToDo.mode).toBe("RECOMMEND_ONLY");
    expect(v.value.whatToDo.approvedActions.map((a) => a.actionLibraryId).sort()).toEqual([
      "ACT-COOLING-INSPECT-MECHANICAL",
      "ACT-COOLING-INSPECT-PRIMARY",
      "ACT-COOLING-REDUCE-LOAD",
      "ACT-COOLING-START-BACKUP",
    ]);
    expect(v.value.sharing.label).toBe("Not available until S6");
    expect(v.value.didItWork.status).toBe("NOT_APPLICABLE_YET");
  });

  it("listCases returns summaries for the actor's organization", async () => {
    const w = await acknowledged();
    const list = await w.operations.listCases(await actor(w, MGR));
    expect(list.ok && list.value).toHaveLength(1);
    expect(list.ok && list.value[0]).toMatchObject({
      caseId: "CASE-1",
      state: "OPEN",
      riskEventState: "ACKNOWLEDGED",
    });
  });
});
