import { describe, expect, it } from "vitest";
import type { DeviceRecord } from "@symbiosis/device-registry";
import { StoreContactDirectory } from "@symbiosis/notifications";
import { InMemoryTenantDocumentStore } from "@symbiosis/repositories";
import { SYNTHETIC_ACTORS } from "@symbiosis/tenancy";
import type { ProvisionRegistry, ProvisionSecrets } from "@symbiosis/adapter-gcp";
import { loadSimulationFacility } from "./config";
import { parseContactAssignments, seedSimulation } from "./simulation-seed";

const facility = loadSimulationFacility();
const API = "symbiosis-api@example.iam.gserviceaccount.com";

function world() {
  const secrets = new Map<string, string[]>();
  const grants: string[] = [];
  const devices = new Map<string, DeviceRecord>();
  const store = new InMemoryTenantDocumentStore();
  const s: ProvisionSecrets = {
    secretExists: async (id) => secrets.has(id),
    createSecret: async (id) => void secrets.set(id, []),
    addVersion: async (id, p) => void secrets.get(id)?.push(p),
    grantAccessor: async (id, m) => void grants.push(`${id}|${m}`),
    deleteSecret: async (id) => void secrets.delete(id),
  };
  const r: ProvisionRegistry = {
    get: async (id) => devices.get(id),
    create: async (d) => {
      if (devices.has(d.deviceId)) throw new Error("ALREADY_EXISTS");
      devices.set(d.deviceId, d);
    },
    put: async (d) => void devices.set(d.deviceId, d),
  };
  return {
    secrets,
    grants,
    devices,
    deps: { secrets: s, registry: r, contactDirectory: new StoreContactDirectory(store) },
  };
}
const request = (contacts: { actorId: string; email: string }[] = [], dryRun = false) => ({
  facility,
  apiServiceAccount: API,
  actors: SYNTHETIC_ACTORS,
  contacts,
  dryRun,
  updatedBy: "operator-seed",
  now: () => "2026-10-02T10:00:00.000Z",
});

describe("simulation seeding", () => {
  it("creates every vendor device with its own key and the weather feed with none, once", async () => {
    const w = world();
    const first = await seedSimulation(w.deps, request());
    expect(first.devices.every((d) => d.action === "CREATED")).toBe(true);
    expect(w.devices.size).toBe(facility.devices.length + 1);
    expect(w.secrets.size).toBe(facility.devices.length); // the pulled weather feed has no secret
    for (const v of w.secrets.values()) expect(v[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(w.grants.every((g) => g.endsWith(`serviceAccount:${API}`))).toBe(true);
    const keys = [...w.secrets.values()].map((v) => v[0]);
    expect(new Set(keys).size).toBe(keys.length); // fresh, distinct keys
    const second = await seedSimulation(w.deps, request());
    expect(second.devices.every((d) => d.action === "KEPT")).toBe(true);
    expect([...w.secrets.values()].map((v) => v[0])).toEqual(keys); // never overwritten
  });

  it("belongs to the simulation tenant only", async () => {
    const w = world();
    await seedSimulation(w.deps, request());
    for (const d of w.devices.values()) {
      expect(d.organizationId).toBe(facility.organizationId);
      expect(d.facilityId).toBe(facility.facilityId);
    }
  });

  it("sets operator-supplied contacts, idempotently, and keeps the owner's own preferences", async () => {
    const w = world();
    const c = [{ actorId: "USR-FACILITY-MGR-001", email: "ops.demo@example.org" }];
    const r1 = await seedSimulation(w.deps, request(c));
    expect(r1.contacts).toEqual([
      { actorId: "USR-FACILITY-MGR-001", address: "o***o@example.org", action: "SET" },
    ]);
    const current = await w.deps.contactDirectory.get(
      facility.organizationId,
      "USR-FACILITY-MGR-001",
    );
    await w.deps.contactDirectory.put({
      ...(current as NonNullable<typeof current>),
      enabled: false,
      categories: ["INITIAL"],
    });
    const r2 = await seedSimulation(w.deps, request(c));
    expect(r2.contacts[0]?.action).toBe("UNCHANGED");
    const kept = await w.deps.contactDirectory.get(facility.organizationId, "USR-FACILITY-MGR-001");
    expect(kept).toMatchObject({ enabled: false, categories: ["INITIAL"] });
  });

  it("refuses a contact for another organization or an invalid address and changes nothing", async () => {
    const w = world();
    const r = await seedSimulation(
      w.deps,
      request([
        { actorId: "USR-OTHER-ORG-MGR-001", email: "x@example.org" },
        { actorId: "USR-FACILITY-MGR-001", email: "not an address" },
      ]),
    );
    expect(r.problems).toHaveLength(2);
    expect(w.devices.size).toBe(0);
    expect(await w.deps.contactDirectory.list(facility.organizationId)).toEqual([]);
  });

  it("a dry run touches nothing", async () => {
    const w = world();
    const r = await seedSimulation(
      w.deps,
      request([{ actorId: "USR-FACILITY-MGR-001", email: "ops.demo@example.org" }], true),
    );
    expect(r.devices.every((d) => d.action === "WOULD_CREATE")).toBe(true);
    expect(r.contacts[0]?.action).toBe("WOULD_SET");
    expect(w.devices.size).toBe(0);
    expect(w.secrets.size).toBe(0);
  });

  it("contains no built-in address and parses operator input strictly", () => {
    const ok = parseContactAssignments(["USR-A=a.b@example.org, USR-B=c@example.org"]);
    expect(ok.assignments).toHaveLength(2);
    expect(
      parseContactAssignments(["USR-A", "=x@example.org", "USR-A=bad", "USR-A=a@b"]).problems,
    ).toHaveLength(4);
  });
});
