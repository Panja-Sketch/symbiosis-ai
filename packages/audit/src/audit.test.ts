import { describe, expect, it } from "vitest";
import { InMemoryAuditLog } from "./index";
import type { NewAuditEntry } from "./index";

const entry = (over: Partial<NewAuditEntry> = {}): NewAuditEntry => ({
  organizationId: "ORG-1",
  facilityId: "FAC-1",
  caseId: "CASE-1",
  actorId: "USR-1",
  actorType: "USER",
  action: "RISK_ACKNOWLEDGED",
  targetType: "RISK_EVENT",
  targetId: "RE-1",
  beforeState: "ALERTED",
  afterState: "ACKNOWLEDGED",
  correlationId: "CORR-1",
  at: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("InMemoryAuditLog (append-only)", () => {
  it("assigns increasing sequence numbers and IDs, preserving order", async () => {
    const log = new InMemoryAuditLog();
    const a = await log.append(entry());
    const b = await log.append(entry({ action: "ACTION_ASSIGNED" }));
    expect([a.sequence, b.sequence]).toEqual([1, 2]);
    expect([a.auditId, b.auditId]).toEqual(["AUD-000001", "AUD-000002"]);
    expect((await log.list("ORG-1")).map((e) => e.action)).toEqual([
      "RISK_ACKNOWLEDGED",
      "ACTION_ASSIGNED",
    ]);
  });

  it("exposes no way to update or delete entries, and stored entries are frozen", async () => {
    const log = new InMemoryAuditLog();
    const stored = await log.append(entry());
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      (stored as { actorId: string }).actorId = "EVIL";
    }).toThrow();
    for (const method of ["update", "delete", "remove", "clear", "set"]) {
      expect((log as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    expect((await log.list("ORG-1"))[0]?.actorId).toBe("USR-1");
  });

  it("scopes reads by organization and case", async () => {
    const log = new InMemoryAuditLog();
    await log.append(entry());
    await log.append(entry({ caseId: "CASE-2" }));
    await log.append(entry({ organizationId: "ORG-2" }));
    expect(await log.listByCase("ORG-1", "CASE-1")).toHaveLength(1);
    expect(await log.list("ORG-1")).toHaveLength(2);
    expect(await log.list("ORG-3")).toEqual([]);
    expect(await log.listByCase("ORG-2", "CASE-1")).toHaveLength(1);
  });
});
