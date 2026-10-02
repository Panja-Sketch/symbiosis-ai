import { createContactsApi, createSimulationApi, createSimulationViews } from "@symbiosis/api";
import type { ContactsApi, SimulationApi } from "@symbiosis/api";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import type { EdgeSubmit, SimulationEngine } from "@symbiosis/simulation";
import type { ActorContext } from "@symbiosis/tenancy";
import type { Ports, Services } from "./compose";

/**
 * Builds the HTTP-facing pieces of the Facility Simulation and of notification contacts from the
 * composed services (S10). Shared by the local runtime and the cloud API entrypoint, so both expose
 * exactly the same routes over exactly the same read models.
 */
export function createSimulationHttp(args: {
  readonly services: Services;
  readonly ports: Ports;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The edge boundary the engine sends signed vendor payloads to. */
  readonly submit: EdgeSubmit;
  /** Runs the scheduler pass now. Absent: `POST /simulation/tick` does not exist. */
  readonly tick?: () => Promise<unknown>;
}): {
  readonly simulation?: SimulationApi;
  readonly contacts: ContactsApi;
  readonly engine?: SimulationEngine;
} {
  const { services, ports, clock, ids } = args;
  const contacts = createContactsApi({
    contacts: services.contacts,
    directory: ports.directory,
    audit: ports.audit,
    ids,
    clock,
  });
  const sim = services.simulation;
  if (sim === undefined) return { contacts };
  const engine = sim.createEngine(args.submit);
  const views = createSimulationViews({
    clock,
    facility: sim.facility,
    observations: ports.observations,
    baselines: ports.baselines,
    registry: ports.registry,
    audit: ports.audit,
    store: ports.documents,
    catalog: services.catalog,
  });
  const simulation = createSimulationApi({
    clock,
    ids,
    facility: sim.facility,
    scenarios: sim.scenarios,
    control: sim.control,
    engine,
    weather: sim.weather,
    policies: sim.policies,
    catalog: services.catalog,
    views,
    audit: ports.audit,
    deliveries: services.deliveries,
    listCases: async (actor: ActorContext) => {
      const r = await services.operations.listCases(actor);
      return r.ok ? r.value : [];
    },
    ...(args.tick !== undefined && { tick: args.tick }),
  });
  return { simulation, contacts, engine };
}
