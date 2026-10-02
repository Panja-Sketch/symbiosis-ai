import {
  Firestore,
  FirestoreDeviceRegistry,
  FirestoreTenantDocumentStore,
  createProvisionSecrets,
} from "@symbiosis/adapter-gcp";
import { StoreContactDirectory } from "@symbiosis/notifications";
import { SYNTHETIC_ACTORS } from "@symbiosis/tenancy";
import {
  loadSimulationFacility,
  parseContactAssignments,
  seedSimulation,
} from "@symbiosis/runtime";

/**
 * Operator-run, idempotent seeding of the Facility Simulation in a project (S10). Synthetic data
 * only; never run by a service. It registers the simulation's vendor devices (fresh random keys in
 * Secret Manager, readable by the API service account only) and the weather feed, and optionally sets
 * notification contacts for synthetic actors of the simulation organization.
 *
 *   GCP_PROJECT_ID=<id> pnpm seed:sim --confirm-project <id> [--dry-run]
 *     [--contact USR-FACILITY-MGR-001=<address>]...   (or SYMBIOSIS_DEMO_CONTACTS="ACTOR=addr,ACTOR=addr")
 *
 * No address is built in: contacts come only from the operator. Addresses are masked in the output.
 */
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const values = (name: string) =>
  argv.flatMap((a, i) =>
    a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1] as string] : [],
  );

const project = process.env.GCP_PROJECT_ID ?? "";
if (!flag("dry-run") && (project === "" || values("confirm-project")[0] !== project)) {
  throw new Error(
    "refusing to seed: pass --confirm-project <GCP_PROJECT_ID> matching GCP_PROJECT_ID",
  );
}
const { assignments, problems } = parseContactAssignments([
  ...values("contact"),
  ...(process.env.SYMBIOSIS_DEMO_CONTACTS === undefined
    ? []
    : [process.env.SYMBIOSIS_DEMO_CONTACTS]),
]);
if (problems.length > 0) throw new Error(problems.join("; "));

const db = new Firestore({ projectId: project === "" ? "dry-run" : project });
const registry = new FirestoreDeviceRegistry({ db });
try {
  const report = await seedSimulation(
    {
      secrets: createProvisionSecrets(project),
      registry: {
        get: (id) => registry.get(id),
        create: (d) => registry.create(d),
        put: (d) => registry.put(d),
      },
      contactDirectory: new StoreContactDirectory(new FirestoreTenantDocumentStore({ db })),
    },
    {
      facility: loadSimulationFacility(),
      apiServiceAccount: `symbiosis-api@${project}.iam.gserviceaccount.com`,
      actors: SYNTHETIC_ACTORS,
      contacts: assignments,
      dryRun: flag("dry-run"),
      updatedBy: "operator-seed",
      now: () => new Date().toISOString(),
    },
  );
  for (const d of report.devices) console.log(`device ${d.deviceId}: ${d.action}`);
  for (const c of report.contacts) console.log(`contact ${c.actorId} (${c.address}): ${c.action}`);
  for (const p of report.problems) console.error(`problem: ${p}`);
  if (report.problems.length > 0) process.exitCode = 1;
} finally {
  await db.terminate();
}
