import { provisionDevice } from "@symbiosis/adapter-gcp";
import type { ProvisionRegistry, ProvisionSecrets } from "@symbiosis/adapter-gcp";
import type { DeviceRecord } from "@symbiosis/device-registry";
import { DEFAULT_CATEGORIES, isValidEmail, maskEmail } from "@symbiosis/notifications";
import type { ContactDirectory } from "@symbiosis/notifications";
import type { FacilityModel } from "@symbiosis/simulation";
import type { ActorContext } from "@symbiosis/tenancy";
import { simulationDeviceRecords } from "./simulation-devices";

/**
 * Operator-run demo seeding for the Facility Simulation (S10), as plain functions over ports so it
 * is tested without a cloud. It is:
 *  - idempotent: a registered device is kept as it is, a secret is never overwritten, a contact that
 *    already holds the requested address is left alone, and a second run changes nothing;
 *  - tenant-scoped: it only touches the simulation organization's devices and contacts, and refuses
 *    a contact for an actor of any other organization;
 *  - synthetic: devices are the simulation's vendor profiles; no address is built in here, every
 *    address comes from the operator (flags or environment) and is validated and masked in output.
 */
export type ContactAssignment = { readonly actorId: string; readonly email: string };

export type SeedSimulationRequest = {
  readonly facility: FacilityModel;
  readonly apiServiceAccount: string;
  readonly actors: readonly ActorContext[];
  readonly contacts: readonly ContactAssignment[];
  readonly dryRun?: boolean;
  readonly updatedBy: string;
  readonly now: () => string;
};

export type SeedSimulationDeps = {
  readonly secrets: ProvisionSecrets;
  readonly registry: ProvisionRegistry;
  readonly contactDirectory: ContactDirectory;
};

export type SeedSimulationReport = {
  readonly devices: readonly {
    readonly deviceId: string;
    readonly action: "CREATED" | "KEPT" | "WOULD_CREATE";
  }[];
  readonly contacts: readonly {
    readonly actorId: string;
    readonly address: string;
    readonly action: "SET" | "UNCHANGED" | "WOULD_SET";
  }[];
  readonly problems: readonly string[];
};

/** Parses `ACTOR=address` pairs (flags or a comma-separated environment value). */
export function parseContactAssignments(values: readonly string[]): {
  readonly assignments: readonly ContactAssignment[];
  readonly problems: readonly string[];
} {
  const assignments: ContactAssignment[] = [];
  const problems: string[] = [];
  for (const raw of values.flatMap((v) => v.split(",")).map((v) => v.trim())) {
    if (raw === "") continue;
    const eq = raw.indexOf("=");
    const actorId = eq < 0 ? "" : raw.slice(0, eq);
    const email = eq < 0 ? "" : raw.slice(eq + 1);
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(actorId) || !isValidEmail(email)) {
      problems.push("a contact must be ACTOR_ID=address with a valid address");
      continue;
    }
    assignments.push({ actorId, email });
  }
  return { assignments, problems };
}

export async function seedSimulation(
  deps: SeedSimulationDeps,
  request: SeedSimulationRequest,
): Promise<SeedSimulationReport> {
  const { facility } = request;
  const org = facility.organizationId;
  const dryRun = request.dryRun === true;
  const problems: string[] = [];

  // Validate every contact before touching anything.
  const knownActors = new Map(request.actors.map((a) => [a.actorId, a]));
  const contacts: ContactAssignment[] = [];
  for (const c of request.contacts) {
    const actor = knownActors.get(c.actorId);
    if (actor === undefined || actor.organizationId !== org) {
      problems.push(`actor ${c.actorId} does not belong to ${org}; its contact was not set`);
    } else if (!isValidEmail(c.email)) {
      problems.push(`the address for ${c.actorId} is not valid`);
    } else {
      contacts.push(c);
    }
  }
  if (problems.length > 0 && !dryRun) {
    return { devices: [], contacts: [], problems };
  }

  const devices: SeedSimulationReport["devices"][number][] = [];
  for (const record of simulationDeviceRecords(facility)) {
    if (record.organizationId !== org || record.facilityId !== facility.facilityId) {
      throw new Error("a simulation device record is outside the simulation facility");
    }
    const existing = await deps.registry.get(record.deviceId);
    if (existing !== undefined) {
      devices.push({ deviceId: record.deviceId, action: "KEPT" });
      continue;
    }
    if (dryRun) {
      devices.push({ deviceId: record.deviceId, action: "WOULD_CREATE" });
      continue;
    }
    await createDevice(deps, record, request.apiServiceAccount);
    devices.push({ deviceId: record.deviceId, action: "CREATED" });
  }

  const results: SeedSimulationReport["contacts"][number][] = [];
  for (const c of contacts) {
    const current = await deps.contactDirectory.get(org, c.actorId);
    const address = maskEmail(c.email);
    if (current?.email === c.email) {
      results.push({ actorId: c.actorId, address, action: "UNCHANGED" });
      continue;
    }
    if (dryRun) {
      results.push({ actorId: c.actorId, address, action: "WOULD_SET" });
      continue;
    }
    await deps.contactDirectory.put({
      actorId: c.actorId,
      organizationId: org,
      email: c.email,
      enabled: current?.enabled ?? true,
      categories: current?.categories ?? DEFAULT_CATEGORIES,
      updatedAt: request.now(),
      updatedBy: request.updatedBy,
    });
    results.push({ actorId: c.actorId, address, action: "SET" });
  }
  return { devices, contacts: results, problems };
}

async function createDevice(
  deps: SeedSimulationDeps,
  record: DeviceRecord,
  apiServiceAccount: string,
): Promise<void> {
  // The platform-pulled weather feed has no key: nothing may ever sign a request for it.
  if (record.capabilities.includes("pull") && !record.capabilities.includes("telemetry")) {
    await deps.registry.create(record);
    return;
  }
  await provisionDevice(
    { secrets: deps.secrets, registry: deps.registry },
    { record, apiServiceAccount },
  );
}
