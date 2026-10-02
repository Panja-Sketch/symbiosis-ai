import { AccessDenied, ErrorState, PageHeader } from "../../../components/ui";
import { SimulationWorkspace } from "../../../components/simulation/SimulationWorkspace";
import { apiGet } from "../../../lib/api";
import { requireSession } from "../../../lib/session";
import type { SimOverview } from "../../../lib/sim-types";

export const metadata = { title: "Facility Simulation" };
export const dynamic = "force-dynamic";

/**
 * The Facility Simulation workspace (S10, D-093): an operations and admin demonstration, never an
 * insurer surface. The page loads the first view on the server; the workspace then keeps itself
 * current through the same-origin proxy.
 */
export default async function SimulationPage() {
  const session = await requireSession();
  if (!session.permissions.includes("SIMULATION_READ")) {
    return (
      <AccessDenied
        title="Not available to this identity"
        homeHref="/operations"
        homeLabel="Back to Operations"
      >
        <p>The Facility Simulation is an operations and administration workspace.</p>
      </AccessDenied>
    );
  }
  const r = await apiGet<SimOverview>(session.actorId, "/api/v1/simulation");
  return (
    <>
      <PageHeader
        title="Facility Simulation"
        lead="A representative cold-storage facility, driven through the real Symbiosis pipeline: sensor payloads from several synthetic vendors, weather context, a deterministic rule, a human response, independent sensor verification, follow-up and recurrence. Everything here that is not labelled LIVE WEATHER is simulation data."
      />
      {r.ok ? (
        <SimulationWorkspace initial={r.value} actorId={session.actorId} />
      ) : r.status === 404 ? (
        <AccessDenied
          title="No simulation for this identity"
          homeHref="/operations"
          homeLabel="Back to Operations"
        >
          <p>
            The simulation belongs to one demonstration organization and facility. This identity has
            no access to it.
          </p>
        </AccessDenied>
      ) : (
        <ErrorState error={r} />
      )}
    </>
  );
}
