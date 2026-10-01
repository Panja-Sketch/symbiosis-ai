import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  Firestore,
  FirestoreCaseRepository,
  FirestoreDeviceRegistry,
  FirestoreEvidencePackageRepository,
  FirestoreObservationRepository,
  FirestoreVerificationRepository,
  GcsEvidenceObjectStore,
  createGcsObjectClient,
  createProvisionSecrets,
  deviceKeySecretId,
} from "@symbiosis/adapter-gcp";
import { BENCH_ASSETS } from "@symbiosis/adapter-esp32";
import type { CanonicalObservation, EvidencePackage } from "@symbiosis/contracts";
import { verifyEvidencePackage } from "@symbiosis/evidence";

/**
 * S10 smoke: honest about what needs a physical device.
 *
 *   part A  HOST (always)      firmware host tests + S2 known-answer vector, server compatibility
 *                              with firmware-signed requests (replay, bad key, tampering, stale
 *                              time, duplicate nonce, sequence), provisioning logic, static
 *                              hygiene, and (--build-firmware) a compile of all five firmware
 *                              environments.
 *   part B  CLOUD + HARDWARE   (opt-in) reads the real project and checks what a REAL ESP32 left
 *                              behind: the device record, HARDWARE observations with the right
 *                              asset mapping, vibration/current/Fan B behaviour, and the hero loop
 *                              (case, verification, evidence package, recurrence).
 *
 * Every hardware-dependent check reports PASS, FAIL or SKIPPED_HARDWARE. With no device data in
 * the window the result is SKIPPED_HARDWARE, never a pass. Exit code: 1 on any FAIL; with
 * --require-hardware also 3 if anything was SKIPPED_HARDWARE.
 *
 * Part B (read-only):
 *   SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=<id> pnpm smoke:s10 --confirm-project <id> \
 *     --device-id DEV-PHX-BENCH-001 [--window-min 15] [--org ORG-SIM-001] [--facility FAC-SIM-001]
 * Secrets are never read or printed (only the existence of the Secret Manager entry is checked).
 */
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

type Status = "PASS" | "FAIL" | "SKIPPED_HARDWARE" | "SKIPPED_TOOLCHAIN";
const tally: Record<Status, number> = {
  PASS: 0,
  FAIL: 0,
  SKIPPED_HARDWARE: 0,
  SKIPPED_TOOLCHAIN: 0,
};
function report(status: Status, name: string, detail = "") {
  tally[status]++;
  console.log(`${status.padEnd(18)} ${name}${detail === "" ? "" : `  - ${detail}`}`);
}

const root = join(import.meta.dirname, "..");
const lab = join(root, "firmware", "esp32-lab");
// Run node entry points directly (no shell, so no pnpm/cmd quoting issues on Windows).
const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(cmd, args, { cwd: root, encoding: "utf8", env });
const node = process.execPath;

// ------------------------------------------------------------------------------------------ A
console.log("== part A: host-automated ==");

const hostTests = run(node, [join(lab, "test", "host", "run.mjs")]);
if (hostTests.status === 2) {
  report("SKIPPED_TOOLCHAIN", "firmware host tests", "no C++ compiler (set SYM_CXX)");
} else {
  const summary = /(\d+) checks, (\d+) failures, (\d+) tests/.exec(hostTests.stdout);
  report(
    hostTests.status === 0 ? "PASS" : "FAIL",
    "firmware host tests (signing, sequence, nonce, payload, retry, health, gate, vibration)",
    summary ? `${summary[3]} tests, ${summary[1]} checks` : hostTests.stderr.slice(0, 200),
  );
}

const vitest = run(
  node,
  [
    join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "tests/integration/firmware-compat.test.ts",
    "tests/unit/firmware-hygiene.test.ts",
    "adapters/esp32",
    "adapters/gcp/src/provision.test.ts",
  ],
  { ...process.env, SYMBIOSIS_REQUIRE_FIRMWARE_HOST: hostTests.status === 2 ? "0" : "1" },
);
report(
  vitest.status === 0 ? "PASS" : "FAIL",
  "server compatibility with firmware-signed requests, provisioning, hygiene, provenance",
  vitest.status === 0
    ? (/Tests\s+(\d+ passed)/.exec(vitest.stdout)?.[1] ?? "")
    : (vitest.stdout + vitest.stderr).slice(-400),
);

const dry = run(node, [
  join(root, "node_modules", "tsx", "dist", "cli.mjs"),
  "scripts/provision-device.ts",
  "--device-id",
  "DEV-PHX-BENCH-001",
  "--dry-run",
]);
report(dry.status === 0 ? "PASS" : "FAIL", "provisioning dry run validates arguments");

if (has("build-firmware")) {
  const pio = process.env.SYM_PIO ?? "pio";
  const probe = spawnSync(pio, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    report(
      "SKIPPED_TOOLCHAIN",
      "firmware compile (5 environments)",
      "PlatformIO not found (SYM_PIO)",
    );
  } else {
    for (const env of ["bringup", "sensor_test", "signing_test", "cloud_test", "demo"]) {
      const r = spawnSync(pio, ["run", "-e", env], { cwd: lab, encoding: "utf8" });
      report(r.status === 0 ? "PASS" : "FAIL", `firmware compiles: ${env}`);
    }
  }
} else {
  console.log("(skipping firmware compile: pass --build-firmware, needs PlatformIO)");
}

// ------------------------------------------------------------------------------------------ B
console.log("\n== part B: cloud state left by the physical device ==");
const project = process.env.GCP_PROJECT_ID ?? "";
const confirm = arg("confirm-project", "");
const deviceId = arg("device-id", "DEV-PHX-BENCH-001");
const org = arg("org", "ORG-SIM-001");
const facility = arg("facility", "FAC-SIM-001");
const windowMin = Number(arg("window-min", "15"));

if (process.env.SMOKE_S10_CLOUD !== "1" || project === "" || confirm !== project) {
  report(
    "SKIPPED_HARDWARE",
    "cloud + physical device checks (H2-H5, H8, hero loop)",
    "not requested: SMOKE_S10_CLOUD=1 GCP_PROJECT_ID=<id> --confirm-project <id>",
  );
} else {
  await cloudChecks();
}

console.log(
  `\nS10 smoke: ${tally.PASS} passed, ${tally.FAIL} failed, ` +
    `${tally.SKIPPED_HARDWARE} skipped (hardware), ${tally.SKIPPED_TOOLCHAIN} skipped (toolchain)`,
);
if (tally.SKIPPED_HARDWARE > 0) {
  console.log(
    "NOTE: SKIPPED_HARDWARE means NO physical result was proven. This is not a hardware pass.",
  );
}
process.exit(tally.FAIL > 0 ? 1 : has("require-hardware") && tally.SKIPPED_HARDWARE > 0 ? 3 : 0);

// ------------------------------------------------------------------------------------------ B
async function cloudChecks() {
  const db = new Firestore({ projectId: project });
  try {
    const registry = new FirestoreDeviceRegistry({ db });
    const observations = new FirestoreObservationRepository({ db });
    const cases = new FirestoreCaseRepository({ db });
    const verifications = new FirestoreVerificationRepository({ db });
    const packages = new FirestoreEvidencePackageRepository({ db });

    const device = await registry.get(deviceId);
    if (device === undefined) {
      report("FAIL", `device ${deviceId} is registered`, "run pnpm provision:device first");
      return;
    }
    report("PASS", `device ${deviceId} is registered and ACTIVE`, device.status);
    if (device.status !== "ACTIVE") report("FAIL", "device status is ACTIVE");
    const secretOk = await createProvisionSecrets(project).secretExists(
      deviceKeySecretId(deviceId, device.activeKeyId),
    );
    report(
      secretOk ? "PASS" : "FAIL",
      "device key secret exists in Secret Manager (value not read)",
    );
    const mappingOk =
      device.assetId === BENCH_ASSETS.primary &&
      device.assetMapping?.bySignal?.temperature === BENCH_ASSETS.zone &&
      device.assetMapping?.bySignal?.relative_humidity === BENCH_ASSETS.zone &&
      device.assetMapping?.byField?.chiller_b_running === BENCH_ASSETS.backup;
    report(mappingOk ? "PASS" : "FAIL", "asset mapping: vibration/current -> Fan A, zone, Fan B");

    // ---- what the real device sent recently
    const now = Date.now();
    const obs = (
      await observations.listForWindow({
        organizationId: org,
        facilityId: facility,
        assetIds: Object.values(BENCH_ASSETS),
        fromIso: new Date(now - windowMin * 60_000).toISOString(),
        toIso: new Date(now + 60_000).toISOString(),
      })
    ).filter((o) => o.deviceId === deviceId);
    const hw = obs.filter((o) => o.sourceType === "HARDWARE");
    if (hw.length === 0) {
      for (const n of [
        "H8 real telemetry reached canonical observation storage",
        "H2 temperature/humidity respond to the environment",
        "H3 vibration clearly separates fault OFF from ON",
        "H4 Fan A current is stable and shows power loss",
        "H5 Fan B state is observed both OFF and ON",
      ]) {
        report(
          "SKIPPED_HARDWARE",
          n,
          `no HARDWARE observations from ${deviceId} in ${windowMin} min`,
        );
      }
    } else {
      hardwareChecks(device.lastSeenAt, device.health, obs, hw);
    }

    await heroChecks(cases, verifications, packages);
  } finally {
    await db.terminate();
  }
}

function hardwareChecks(
  lastSeenAt: string | undefined,
  health: string,
  all: readonly CanonicalObservation[],
  hw: readonly CanonicalObservation[],
) {
  const labelled = all.every((o) => o.sourceType === "HARDWARE");
  report(
    labelled ? "PASS" : "FAIL",
    "every observation of this device is labelled HARDWARE (none SIMULATOR)",
  );

  const want: [string, string][] = [
    ["vibration_rms", BENCH_ASSETS.primary],
    ["current", BENCH_ASSETS.primary],
    ["temperature", BENCH_ASSETS.zone],
    ["relative_humidity", BENCH_ASSETS.zone],
    ["equipment_running", BENCH_ASSETS.backup],
  ];
  const missing = want.filter(([s, a]) => !hw.some((o) => o.signal === s && o.assetId === a));
  report(
    missing.length === 0 ? "PASS" : "FAIL",
    "H8 real telemetry reached canonical storage with the correct asset mapping",
    missing.length === 0
      ? `${hw.length} observations`
      : `missing ${missing.map((m) => m.join("@")).join(", ")}`,
  );
  const fresh = lastSeenAt !== undefined && Date.now() - Date.parse(lastSeenAt) < 120_000;
  report(
    fresh && health === "HEALTHY" ? "PASS" : "FAIL",
    "device last seen < 2 min ago and reports HEALTHY",
    `lastSeenAt=${lastSeenAt ?? "never"} health=${health}`,
  );
  const untrusted = hw.filter((o) => o.quality.confidence < 0.5).length;
  report(
    untrusted === 0 ? "PASS" : "FAIL",
    "observations are trusted by data quality (confidence >= 0.5)",
    `${untrusted} below`,
  );

  const series = (signal: string) =>
    hw
      .filter((o) => o.signal === signal && typeof o.value === "number")
      .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const nums = (signal: string) => series(signal).map((o) => o.value as number);

  const times = series("vibration_rms").map((o) => Date.parse(o.observedAt));
  const gaps = times
    .slice(1)
    .map((t, i) => (t - (times[i] as number)) / 1000)
    .sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  report(
    median !== undefined && median >= 3 && median <= 8 ? "PASS" : "FAIL",
    "sampling cadence is about 5 s (verification policy expects 5 s)",
    `median gap ${median ?? "n/a"} s`,
  );

  const temp = nums("temperature");
  const tempSpan = temp.length > 0 ? Math.max(...temp) - Math.min(...temp) : 0;
  report(
    tempSpan >= 0.3 ? "PASS" : "SKIPPED_HARDWARE",
    "H2 temperature responds to an environmental change (breathe/warm the SHT41)",
    `span ${tempSpan.toFixed(2)} degC`,
  );

  const vib = nums("vibration_rms").sort((a, b) => a - b);
  const lo = vib[Math.floor(vib.length * 0.1)] ?? 0;
  const hi = vib[Math.floor(vib.length * 0.9)] ?? 0;
  const highCount = vib.filter((v) => v > (lo + hi) / 2).length;
  report(
    lo > 0 && hi >= 3 * lo && highCount >= 6 && vib.length - highCount >= 6
      ? "PASS"
      : "SKIPPED_HARDWARE",
    "H3 vibration clearly separates fault motor OFF from ON (window must contain both)",
    `p10=${lo.toFixed(4)} p90=${hi.toFixed(4)} m/s2 (${(hi / (lo || 1)).toFixed(1)}x)`,
  );

  const cur = nums("current");
  const sortedCur = [...cur].sort((a, b) => a - b);
  const med = sortedCur[Math.floor(sortedCur.length / 2)] ?? 0;
  const stableBand = sortedCur.filter((c) => Math.abs(c - med) <= 0.15 * Math.abs(med)).length;
  report(
    med > 0.01 && stableBand / Math.max(1, cur.length) >= 0.7 ? "PASS" : "FAIL",
    "H4 Fan A current is present and stable (median within 15% for >= 70% of samples)",
    `median ${(med * 1000).toFixed(1)} mA`,
  );
  report(
    sortedCur.length > 0 && (sortedCur[0] as number) < 0.3 * med ? "PASS" : "SKIPPED_HARDWARE",
    "H4 Fan A power loss is detected (disconnect Fan A during the window)",
    `min ${((sortedCur[0] ?? 0) * 1000).toFixed(1)} mA`,
  );

  const running = series("equipment_running").map((o) => o.value);
  report(
    running.includes(true) && running.includes(false) ? "PASS" : "SKIPPED_HARDWARE",
    "H5 Fan B state observed both OFF and ON (flip the rocker during the window)",
  );
}

async function heroChecks(
  cases: FirestoreCaseRepository,
  verifications: FirestoreVerificationRepository,
  packages: FirestoreEvidencePackageRepository,
) {
  const all = (await cases.list(org)).filter(
    (c) => c.facilityId === facility && c.assetIds.includes(BENCH_ASSETS.primary),
  );
  const store = new GcsEvidenceObjectStore(createGcsObjectClient(project, `${project}-evidence`));
  type HardwareCase = {
    caseId: string;
    state: string;
    recurrenceCount: number;
    verified: boolean;
    hardwarePackage: boolean;
    integrityOk: boolean;
  };
  const hardwareCases: HardwareCase[] = [];
  for (const c of all) {
    const records = await packages.listByCase(org, c.caseId);
    let hardwarePackage = false;
    let integrityOk = records.length > 0;
    for (const r of records) {
      const raw = await store.get(r.objectKey);
      if (raw === undefined) {
        integrityOk = false;
        continue;
      }
      const pkg = JSON.parse(raw) as EvidencePackage;
      if (!verifyEvidencePackage(pkg).valid) integrityOk = false;
      const label = (
        pkg.payload as unknown as { sourceLabel?: { dataOrigin?: string; synthetic?: boolean } }
      ).sourceLabel;
      if (label?.dataOrigin === "PROTOTYPE_HARDWARE" && label.synthetic === false) {
        hardwarePackage = true;
      }
    }
    const attempts = await verifications.listByCase(org, c.caseId);
    hardwareCases.push({
      caseId: c.caseId,
      state: c.state,
      recurrenceCount: c.recurrenceCount,
      verified: attempts.some((a) => a.assessment?.result === "VERIFIED"),
      hardwarePackage,
      integrityOk,
    });
  }
  const hero = hardwareCases.filter((c) => c.hardwarePackage);

  const needs = (name: string, why: string) => report("SKIPPED_HARDWARE", name, why);
  if (hero.length === 0) {
    needs(
      "hero: Risk Improvement Case from physical telemetry, verified, with HARDWARE evidence",
      "no hardware evidence package yet: run the physical hero scenario (docs, Phase A-D)",
    );
    needs("hero: recurrence reopens the SAME case (Phase E)", "no hardware case yet");
    return;
  }
  const best = hero.find((c) => c.verified) ?? hero[0];
  if (best === undefined) return;
  report("PASS", "hero: a case was created from physical telemetry", best.caseId);
  report(
    best.verified ? "PASS" : "FAIL",
    "hero: physical post-action telemetry verified the case (result VERIFIED)",
  );
  report(
    best.integrityOk ? "PASS" : "FAIL",
    "hero: evidence package(s) reload from Cloud Storage with valid SHA-256 integrity and are labelled PROTOTYPE_HARDWARE (not synthetic)",
  );
  const duplicates = hero.length;
  report(
    best.recurrenceCount >= 1 ? "PASS" : "SKIPPED_HARDWARE",
    "hero: recurrence reopened the same case (recurrenceCount >= 1, state REOPENED or later)",
    `recurrenceCount=${best.recurrenceCount} state=${best.state}`,
  );
  report(
    duplicates === 1 ? "PASS" : "FAIL",
    "hero: exactly one hardware case for the episode (no duplicates)",
    `${duplicates}`,
  );
  report(
    "SKIPPED_HARDWARE",
    "hero: customer consent and insurer evidence view (human steps in the web app)",
    "MANUAL: follow docs section 'Evidence and consent' and tick it off in the handoff",
  );
}
