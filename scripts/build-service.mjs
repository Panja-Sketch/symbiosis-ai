// Bundles one deployable (api or worker) into dist/<service>/main.mjs (S9).
// Workspace TypeScript is compiled and inlined; the cloud SDKs stay external and are installed
// from the lockfile into the image (see Dockerfile.service), so the bundle holds no third-party code.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

const service = process.argv[2];
const entries = {
  api: "packages/runtime/src/main-api.ts",
  worker: "packages/runtime/src/main-worker.ts",
};
if (entries[service] === undefined) {
  console.error("usage: node scripts/build-service.mjs api|worker");
  process.exit(2);
}
mkdirSync(`dist/${service}`, { recursive: true });
await build({
  entryPoints: [entries[service]],
  outfile: `dist/${service}/main.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  logLevel: "info",
  external: ["@google-cloud/*", "firebase-admin", "firebase-admin/*", "google-auth-library"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});
