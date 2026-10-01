// Local development launcher (spec section 39), temporary S2 form.
//
// Runs: api + worker (one process, joined by the in-memory bus) and the simulator.
// NOT run yet: `web` (Next.js arrives in S7). The locked target is still web, api, worker,
// simulator as separate deployables; api and worker share a process locally only because the
// local event bus is in-memory.
import { spawn } from "node:child_process";

const port = process.env.EDGE_PORT ?? "8787";
const children = [];

function run(name, file, env = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", file], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? "signal"})`);
    shutdown(code ?? 1);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill();
  setTimeout(() => process.exit(code), 200);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("[dev] web: NOT IMPLEMENTED (arrives in S7); starting api+worker and simulator");
run("api+worker", "scripts/dev-runtime.ts", { EDGE_PORT: port });
setTimeout(() => {
  run("simulator", "apps/simulator/src/main.ts", { EDGE_BASE_URL: `http://127.0.0.1:${port}` });
}, 1500);
