// Local development launcher (spec section 39).
//
// Runs: api + worker (one process, joined by the in-memory bus), the simulator and the Next.js web
// app (S7). The locked target is still web, api, worker and simulator as separate deployables;
// api and worker share a process locally only because the local event bus is in-memory. The web
// app talks to the API over HTTP only (SYMBIOSIS_API_URL).
import { spawn } from "node:child_process";

const port = process.env.EDGE_PORT ?? "8787";
const webPort = process.env.WEB_PORT ?? "3000";
const children = [];

function run(name, args, { env = {}, cwd } = {}) {
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    ...(cwd !== undefined && { cwd }),
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

console.log(`[dev] api+worker :${port}, simulator, web http://127.0.0.1:${webPort}`);
run("api+worker", ["--import", "tsx", "scripts/dev-runtime.ts"], { env: { EDGE_PORT: port } });
run("web", ["node_modules/next/dist/bin/next", "dev", "-p", webPort], {
  cwd: "apps/web",
  env: { SYMBIOSIS_API_URL: `http://127.0.0.1:${port}` },
});
setTimeout(() => {
  run("simulator", ["--import", "tsx", "apps/simulator/src/main.ts"], {
    env: { EDGE_BASE_URL: `http://127.0.0.1:${port}` },
  });
}, 1500);
