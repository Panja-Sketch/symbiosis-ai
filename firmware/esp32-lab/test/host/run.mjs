#!/usr/bin/env node
// Builds and runs the host-side firmware tests (no ESP32 needed).
//   node firmware/esp32-lab/test/host/run.mjs [--build-only]
// Compiler: $SYM_CXX (may contain spaces, e.g. "python -m ziglang c++"), else c++/g++/clang++.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lab = resolve(here, "../..");
const repo = resolve(lab, "../..");
const core = join(lab, "lib/symcore/src");
const outDir = join(lab, ".host-build");

export function findCompiler() {
  const candidates = process.env.SYM_CXX ? [process.env.SYM_CXX] : ["c++", "g++", "clang++"];
  for (const c of candidates) {
    const parts = c.split(" ").filter(Boolean);
    const probe = spawnSync(parts[0], [...parts.slice(1), "--version"], { encoding: "utf8" });
    if (probe.status === 0) return parts;
  }
  return undefined;
}

export function buildHost() {
  const cxx = findCompiler();
  if (cxx === undefined) return { ok: false, reason: "no C++ compiler (set SYM_CXX)" };
  mkdirSync(outDir, { recursive: true });
  const sources = readdirSync(core)
    .filter((f) => f.endsWith(".cpp"))
    .map((f) => join(core, f));
  const exe = process.platform === "win32" ? ".exe" : "";
  const common = [
    "-std=c++17",
    "-O1",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-nullability-completeness",
    `-I${core}`,
  ];
  const targets = [
    ["test_core", join(here, "test_core.cpp")],
    ["sym_cli", join(here, "sym_cli.cpp")],
  ];
  for (const [name, src] of targets) {
    const out = join(outDir, name + exe);
    const r = spawnSync(cxx[0], [...cxx.slice(1), ...common, ...sources, src, "-o", out], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      return { ok: false, reason: `compile of ${name} failed:\n${r.stdout}${r.stderr}` };
    }
  }
  return {
    ok: true,
    testExe: join(outDir, "test_core" + exe),
    cliExe: join(outDir, "sym_cli" + exe),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const built = buildHost();
  if (!built.ok) {
    console.error(built.reason);
    process.exit(2);
  }
  if (process.argv.includes("--build-only")) process.exit(0);
  const r = spawnSync(built.testExe, [repo], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
