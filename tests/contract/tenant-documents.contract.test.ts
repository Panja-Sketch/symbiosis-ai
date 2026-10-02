import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, inject, it } from "vitest";
import { Firestore, FirestoreAuditLog, FirestoreTenantDocumentStore } from "@symbiosis/adapter-gcp";
import { InMemoryAuditLog } from "@symbiosis/audit";
import type { AuditLog } from "@symbiosis/audit";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import type { TenantDocumentStore } from "@symbiosis/repositories";

/**
 * The same behavior from the in-memory and the Firestore tenant document store (S10, D-091), plus
 * the incremental audit reads the simulation timeline relies on.
 */
function documentContract(
  name: string,
  make: () => { store: TenantDocumentStore; audit: AuditLog },
  options: { skip?: boolean } = {},
) {
  const d = options.skip === true ? describe.skip : describe;
  d(`tenant documents + audit tail: ${name}`, () => {
    it("creates once, atomically, and reads back plain JSON", async () => {
      const { store } = make();
      expect(await store.create("contacts", "ORG-A", "USR-1", { enabled: true, n: 1 })).toBe(true);
      expect(await store.create("contacts", "ORG-A", "USR-1", { enabled: false })).toBe(false);
      expect(await store.get("contacts", "ORG-A", "USR-1")).toEqual({ enabled: true, n: 1 });
      expect(await store.get("contacts", "ORG-A", "USR-404")).toBeUndefined();
    });

    it("is tenant scoped: another organization sees nothing", async () => {
      const { store } = make();
      await store.put("contacts", "ORG-A", "USR-1", { a: 1 }, { actorId: "USR-1" });
      expect(await store.get("contacts", "ORG-B", "USR-1")).toBeUndefined();
      expect(await store.list("contacts", "ORG-B")).toEqual([]);
      expect(await store.list("contacts", "ORG-A")).toEqual([{ a: 1 }]);
      await store.delete("contacts", "ORG-B", "USR-1");
      expect(await store.get("contacts", "ORG-A", "USR-1")).toEqual({ a: 1 });
      expect(await store.purge("contacts", "ORG-B")).toBe(0);
      expect(await store.get("contacts", "ORG-A", "USR-1")).toEqual({ a: 1 });
    });

    it("rejects documents JSON would silently change, and unsafe ids", async () => {
      const { store } = make();
      await expect(store.put("contacts", "O", "x", { v: Number.NaN })).rejects.toThrow();
      await expect(store.put("contacts", "O", "x", { v: () => 1 })).rejects.toThrow();
      await expect(store.put("contacts", "O", "../x", { v: 1 })).rejects.toThrow();
      await expect(store.put("contacts", "O", "a/b", { v: 1 })).rejects.toThrow();
    });

    it("filters by index fields (equality) and honors the limit", async () => {
      const { store } = make();
      for (let i = 0; i < 5; i += 1) {
        await store.put(
          "adapterTraces",
          "ORG-A",
          `T${i}`,
          { i },
          { deviceId: i < 3 ? "D1" : "D2" },
        );
      }
      const d1 = await store.list<{ i: number }>("adapterTraces", "ORG-A", {
        where: { deviceId: "D1" },
      });
      expect(d1.map((x) => x.i).sort()).toEqual([0, 1, 2]);
      expect(await store.list("adapterTraces", "ORG-A", { limit: 2 })).toHaveLength(2);
      expect(await store.list("adapterTraces", "ORG-A", { where: { deviceId: "none" } })).toEqual(
        [],
      );
    });

    it("update is a read-modify-write and may decline", async () => {
      const { store } = make();
      const r1 = await store.update<{ n: number }>("simulationControl", "ORG-A", "C", (cur) => ({
        doc: { n: (cur?.n ?? 0) + 1 },
      }));
      expect(r1).toEqual({ n: 1 });
      const r2 = await store.update<{ n: number }>(
        "simulationControl",
        "ORG-A",
        "C",
        () => undefined,
      );
      expect(r2).toEqual({ n: 1 });
      expect(await store.get("simulationControl", "ORG-A", "C")).toEqual({ n: 1 });
    });

    it("keeps index fields across an update that does not replace them", async () => {
      const { store } = make();
      await store.put(
        "notificationDeliveries",
        "ORG-A",
        "A#1",
        { s: "PENDING" },
        { alertId: "A", status: "PENDING" },
      );
      await store.update<{ s: string }>("notificationDeliveries", "ORG-A", "A#1", () => ({
        doc: { s: "SENT" },
      }));
      expect(
        await store.list("notificationDeliveries", "ORG-A", { where: { alertId: "A" } }),
      ).toEqual([{ s: "SENT" }]);
    });

    it("concurrent updates never lose an increment", { timeout: 60_000 }, async () => {
      const { store } = make();
      await Promise.all(
        Array.from({ length: 6 }, () =>
          store.update<{ n: number }>("simulationControl", "ORG-A", "K", (cur) => ({
            doc: { n: (cur?.n ?? 0) + 1 },
          })),
        ),
      );
      expect(await store.get("simulationControl", "ORG-A", "K")).toEqual({ n: 6 });
    });

    it("purge deletes only the matching documents of that organization and collection", async () => {
      const { store } = make();
      await store.put("adapterTraces", "ORG-A", "T1", { a: 1 }, { facilityId: "F1" });
      await store.put("adapterTraces", "ORG-A", "T2", { a: 2 }, { facilityId: "F2" });
      await store.put("adapterTraces", "ORG-B", "T1", { a: 3 }, { facilityId: "F1" });
      await store.put("contacts", "ORG-A", "C1", { c: 1 });
      expect(await store.purge("adapterTraces", "ORG-A", { facilityId: "F1" })).toBe(1);
      expect(await store.get("adapterTraces", "ORG-A", "T1")).toBeUndefined();
      expect(await store.get("adapterTraces", "ORG-A", "T2")).toEqual({ a: 2 });
      expect(await store.get("adapterTraces", "ORG-B", "T1")).toEqual({ a: 3 });
      expect(await store.get("contacts", "ORG-A", "C1")).toEqual({ c: 1 });
      expect(await store.purge("adapterTraces", "ORG-A")).toBe(1);
    });

    it("audit: reads only the new tail, per organization, in order", async () => {
      const { audit } = make();
      const e = (org: string, n: number) =>
        audit.append({
          organizationId: org,
          facilityId: "F",
          actorId: "A",
          actorType: "SYSTEM",
          action: "CASE_CREATED",
          targetType: "CASE",
          targetId: `C${n}`,
          correlationId: "CORR",
          at: "2026-10-02T00:00:00.000Z",
        });
      expect(await audit.lastSequence("ORG-A")).toBe(0);
      await e("ORG-A", 1);
      await e("ORG-B", 1);
      await e("ORG-A", 2);
      await e("ORG-A", 3);
      const last = await audit.lastSequence("ORG-A");
      expect(last).toBeGreaterThanOrEqual(3);
      const all = await audit.list("ORG-A");
      const tail = await audit.listAfter("ORG-A", all[0]?.sequence ?? 0);
      expect(tail.map((x) => x.targetId)).toEqual(["C2", "C3"]);
      expect(tail.every((x) => x.organizationId === "ORG-A")).toBe(true);
      expect(await audit.listAfter("ORG-A", last)).toEqual([]);
      expect((await audit.listAfter("ORG-A", 0, 2)).length).toBe(2);
      expect(await audit.listAfter("ORG-C", 0)).toEqual([]);
    });
  });
}

documentContract("in-memory", () => ({
  store: new InMemoryTenantDocumentStore(),
  audit: new InMemoryAuditLog(),
}));

const host = inject("firestoreEmulatorHost");
const firestores: Firestore[] = [];

documentContract(
  "firestore (emulator)",
  () => {
    const db = new Firestore({
      projectId: "demo-symbiosis-contract",
      host: host ?? "127.0.0.1:1",
      ssl: false,
      customHeaders: { Authorization: "Bearer owner" },
    });
    firestores.push(db);
    const o = { db, collectionPrefix: `t${randomUUID().replaceAll("-", "").slice(0, 12)}_` };
    return { store: new FirestoreTenantDocumentStore(o), audit: new FirestoreAuditLog(o) };
  },
  { skip: host === null },
);

afterAll(async () => {
  await Promise.all(firestores.map((f) => f.terminate()));
});
