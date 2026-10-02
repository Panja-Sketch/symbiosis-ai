import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.{ts,tsx}", "{apps,packages,adapters}/*/src/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
    // The suite runs ~70 files in parallel next to a Firestore emulator; a loaded machine must not
    // turn a slow-but-correct test into a failure.
    testTimeout: 20_000,
    globalSetup: ["tests/support/firestore-emulator.ts"],
  },
});
