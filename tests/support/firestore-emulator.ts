import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * Vitest global setup: gives the Firestore contract suites an emulator (S9).
 *  1. FIRESTORE_EMULATOR_HOST already set -> use it.
 *  2. else start the Firestore emulator jar (FIRESTORE_EMULATOR_JAR, or the firebase-tools cache
 *     under ~/.cache/firebase/emulators) with Java on a free port, and stop it afterwards.
 *  3. else provide nothing: the Firestore suites report themselves as SKIPPED with a loud warning
 *     (set SYMBIOSIS_REQUIRE_EMULATOR=1 to make that a failure instead, as CI should).
 * Production credentials are never used here: the emulator is local and the project id is fake.
 */
declare module "vitest" {
  export interface ProvidedContext {
    firestoreEmulatorHost: string | null;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

function findJar(): string | undefined {
  const fromEnv = process.env.FIRESTORE_EMULATOR_JAR;
  if (fromEnv !== undefined && existsSync(fromEnv)) return fromEnv;
  const dir = join(homedir(), ".cache", "firebase", "emulators");
  if (!existsSync(dir)) return undefined;
  const jar = readdirSync(dir)
    .filter((f) => /^cloud-firestore-emulator.*\.jar$/.test(f))
    .sort()
    .at(-1);
  return jar === undefined ? undefined : join(dir, jar);
}

async function waitReady(host: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}/`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

let child: ChildProcess | undefined;

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const required = process.env.SYMBIOSIS_REQUIRE_EMULATOR === "1";
  const existing = process.env.FIRESTORE_EMULATOR_HOST;
  if (existing !== undefined && existing !== "") {
    project.provide("firestoreEmulatorHost", existing);
    return async () => {};
  }
  const jar = findJar();
  if (jar !== undefined) {
    const port = await freePort();
    const host = `127.0.0.1:${port}`;
    child = spawn("java", ["-jar", jar, "--host=127.0.0.1", `--port=${port}`], {
      stdio: "ignore",
    });
    child.on("error", () => {});
    if (await waitReady(host, 60_000)) {
      project.provide("firestoreEmulatorHost", host);
      return async () => {
        child?.kill();
      };
    }
    child.kill();
  }
  const message =
    "Firestore emulator unavailable (need Java plus FIRESTORE_EMULATOR_JAR or the firebase-tools " +
    "cache, or FIRESTORE_EMULATOR_HOST). Firestore contract suites will NOT run.";
  if (required) throw new Error(message);
  console.warn(`\n[symbiosis] WARNING: ${message}\n`);
  project.provide("firestoreEmulatorHost", null);
  return async () => {};
}
