import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  // The monorepo root holds the lockfile; pin it so Next does not guess.
  outputFileTracingRoot: root,
  turbopack: { root },
};
