import { mkdirSync, writeFileSync } from "node:fs";
import { Firestore, seedGcp } from "@symbiosis/adapter-gcp";

/**
 * Operator-run, explicit, idempotent demo seeding (S9). Synthetic data only. Never run by a
 * service at startup. Usage:
 *   GCP_PROJECT_ID=<id> pnpm seed:gcp --confirm-project <id> [--reset-passwords]
 * New or reset demo-user passwords are written to .secrets/demo-users.json (git-ignored) and are
 * never printed.
 */
const project = process.env.GCP_PROJECT_ID ?? "";
const confirm = process.argv[process.argv.indexOf("--confirm-project") + 1];
if (project === "" || confirm !== project) {
  throw new Error(
    "refusing to seed: pass --confirm-project <GCP_PROJECT_ID> matching GCP_PROJECT_ID",
  );
}
const db = new Firestore({ projectId: project });
const result = await seedGcp({
  firestore: { db },
  projectId: project,
  apiServiceAccount: `symbiosis-api@${project}.iam.gserviceaccount.com`,
  resetPasswords: process.argv.includes("--reset-passwords"),
});
if (Object.keys(result.passwords).length > 0) {
  mkdirSync(".secrets", { recursive: true });
  writeFileSync(".secrets/demo-users.json", JSON.stringify(result.passwords, null, 2), {
    mode: 0o600,
  });
}
console.log(
  `seeded ${project}: users created=${result.createdUsers.length}, passwords written=${Object.keys(result.passwords).length}, device key created=${result.deviceKeyCreated}`,
);
await db.terminate();
