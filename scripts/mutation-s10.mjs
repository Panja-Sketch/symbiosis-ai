#!/usr/bin/env node
// S10 mutation checks: each mutation breaks one guarantee on purpose and the matching tests must
// FAIL. The file is always restored (also on Ctrl+C). Never run this while a build or deploy is
// being prepared (S9 lesson: a mutant once reached a Cloud Build upload).
//   node scripts/mutation-s10.mjs [--only <n>]
// Needs a host C++ compiler for the firmware cases (set SYM_CXX), like `pnpm test:firmware`.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lab = "firmware/esp32-lab";
const core = `${lab}/lib/symcore/src`;

const host = { cmd: "node", args: [`${lab}/test/host/run.mjs`], expectExit: 1 };
const vitest = (...files) => ({
  cmd: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  args: ["exec", "vitest", "run", ...files],
  expectExit: 1,
  env: { SYMBIOSIS_REQUIRE_FIRMWARE_HOST: "1" },
});
const hygiene = vitest("tests/unit/firmware-hygiene.test.ts");
const compat = vitest("tests/integration/firmware-compat.test.ts");

const mutations = [
  {
    n: 1,
    name: "sequence resets to zero on reboot",
    file: `${core}/sym_sequence.cpp`,
    from: "current_ = hi;\n  reserved_ = hi;",
    to: "current_ = 0;\n  reserved_ = 0;",
    run: host,
  },
  {
    n: 2,
    name: "nonce reused (generator ignores entropy)",
    file: `${core}/sym_nonce.cpp`,
    from: "if (rng_ == nullptr || !rng_(rnd, sizeof(rnd))) return false;",
    to: "if (rng_ == nullptr || !rng_(rnd, sizeof(rnd))) return false;\n    memset(rnd, 7, sizeof(rnd));",
    run: host,
  },
  {
    n: 3,
    name: "signature omits the body hash",
    file: `${core}/sym_signing.cpp`,
    from: "w.put(body_sha256_hex);  // last line: no trailing newline",
    to: "w.put(body_sha256_hex + 64);",
    run: host,
  },
  {
    n: 4,
    name: "signing material in the wrong order (seq before nonce)",
    file: `${core}/sym_signing.cpp`,
    from: "  w.put(nonce);\n  w.nl();\n  u64_to_dec(seq, num, sizeof(num));\n  w.put(num);\n",
    to: "  u64_to_dec(seq, num, sizeof(num));\n  w.put(num);\n  w.nl();\n  w.put(nonce);\n",
    run: host,
  },
  {
    n: 5,
    name: "device key accidentally logged",
    file: `${lab}/src/main.cpp`,
    from: 'LOGF("boot", "api=%s", SYM_API_BASE_URL);',
    to: 'LOGF("boot", "api=%s", SYM_API_BASE_URL);\n  LOGF("boot", "k=%s", SYM_DEVICE_KEY_HEX);',
    run: hygiene,
  },
  {
    n: 6,
    name: "device marked healthy although a required sensor failed",
    file: `${core}/sym_health.cpp`,
    from: "if (!s.mpu6050_ok || !s.ina219_ok) return Health::kFault;",
    to: "if (false) return Health::kFault;",
    run: host,
  },
  {
    n: 7,
    name: "replay accepted (nonce and sequence reuse not rejected)",
    file: "packages/edge-security/src/replay.ts",
    from: 'if (s.nonces.has(check.nonce)) return { ok: false, reason: "NONCE_REPLAY" };',
    to: 'if (false) return { ok: false, reason: "NONCE_REPLAY" };',
    extra: {
      from: 'if (check.seq === s.lastSeq) return { ok: false, reason: "SEQUENCE_REUSE" };',
      to: "",
    },
    run: compat,
  },
  {
    n: 8,
    name: "firmware labels hardware data SIMULATOR",
    file: `${core}/sym_payload.h`,
    from: 'kSourceHardware = "HARDWARE"',
    to: 'kSourceHardware = "SIMULATOR"',
    run: host,
  },
  {
    n: "8b",
    name: "server adapter labels hardware observations SIMULATOR",
    file: "adapters/esp32/src/index.ts",
    from: 'sourceType: "HARDWARE"',
    to: 'sourceType: "SIMULATOR"',
    run: vitest("adapters/esp32", "tests/integration/firmware-compat.test.ts"),
  },
  {
    n: 9,
    name: "cloud-to-actuator path added in the firmware network code",
    file: `${lab}/src/transport.cpp`,
    from: '#include "transport.h"',
    to: '#include "transport.h"\n#include "io.h"',
    run: hygiene,
  },
  {
    n: "9b",
    name: "cloud-to-actuator command added to the API response",
    file: "apps/api/src/edge-handler.ts",
    from: 'return { status: 202, body: { status: "accepted", correlationId, receivedAt } };',
    to: 'return { status: 202, body: { status: "accepted", correlationId, receivedAt, actuatorCommand: "fan_b_on" } };',
    run: hygiene,
  },
  {
    n: 10,
    name: "firmware sends telemetry before clock sync",
    file: `${core}/sym_gate.cpp`,
    from: "if (!g.time_synced) return Block::kNoTime;",
    to: "",
    run: host,
  },
];

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? process.argv[onlyAt + 1] : undefined;

let restoreNow = () => {};
process.on("SIGINT", () => {
  restoreNow();
  process.exit(130);
});

let failures = 0;
for (const m of mutations) {
  if (only !== undefined && String(m.n) !== only) continue;
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  restoreNow = () => writeFileSync(path, original);
  if (!original.includes(m.from)) {
    console.log(`#${m.n} ${m.name}: MUTATION DID NOT APPLY (pattern not found)`);
    failures++;
    continue;
  }
  let mutated = original.replace(m.from, m.to);
  if (m.extra) {
    if (!mutated.includes(m.extra.from)) {
      console.log(`#${m.n} ${m.name}: second pattern not found`);
      failures++;
      continue;
    }
    mutated = mutated.replace(m.extra.from, m.extra.to);
  }
  try {
    writeFileSync(path, mutated);
    const r = spawnSync(m.run.cmd, m.run.args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...(m.run.env ?? {}) },
      shell: process.platform === "win32" && m.run.cmd.endsWith(".cmd"),
    });
    const detected = r.status === m.run.expectExit;
    const out = `${r.stdout}${r.stderr}`;
    const failed =
      /(\d+) failures/.exec(out)?.[1] ??
      /Tests\s+(\d+) failed/.exec(out)?.[1] ??
      (r.status === m.run.expectExit ? "?" : "0");
    console.log(
      `#${m.n} ${m.name}: ${detected ? "DETECTED" : "SURVIVED"} (exit ${r.status}, failed: ${failed})`,
    );
    if (!detected) failures++;
  } finally {
    restoreNow();
  }
}
console.log(failures === 0 ? "all mutations detected, files restored" : `${failures} PROBLEM(S)`);
process.exit(failures === 0 ? 0 : 1);
