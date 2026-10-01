// S0 placeholder. Local runtime (web, api, worker, simulator) does not exist yet.
console.error(
  [
    "pnpm dev: NOT IMPLEMENTED.",
    "No local runtime exists in Phase S0 (repository foundation only).",
    "api/worker/simulator arrive in S2+; web (Next.js) arrives in S7.",
    "See docs/IMPLEMENTATION_STATE.md.",
  ].join("\n"),
);
process.exit(1);
