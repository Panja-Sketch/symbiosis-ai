import { defineConfig, devices } from "@playwright/test";

/**
 * S7 browser tests. Three processes: the REAL local backend on a simulated clock (with a small
 * control port that only feeds telemetry and advances time), and the production build of the
 * Next.js web app, which talks to that backend over HTTP exactly as it does in `pnpm dev`.
 * Build the web app first (`pnpm test:e2e` does).
 */
export const E2E_API_PORT = 8791;
export const E2E_CONTROL_PORT = 8792;
export const E2E_WEB_PORT = 3100;

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${E2E_WEB_PORT}`,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm exec tsx scripts/s7-backend.ts",
      url: `http://127.0.0.1:${E2E_CONTROL_PORT}/control/health`,
      env: { S7_API_PORT: String(E2E_API_PORT), S7_CONTROL_PORT: String(E2E_CONTROL_PORT) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `pnpm --dir apps/web exec next start -p ${E2E_WEB_PORT}`,
      url: `http://127.0.0.1:${E2E_WEB_PORT}/trust`,
      env: { SYMBIOSIS_API_URL: `http://127.0.0.1:${E2E_API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
