import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guards for the S10 firmware and the cloud boundary. They need no compiler and no board.
 * They exist because some failure modes (a logged key, a hidden actuator path, a hardware packet
 * labelled synthetic) are structural, not behavioural.
 */
const root = join(import.meta.dirname, "..", "..");
const lab = join(root, "firmware", "esp32-lab");
const rel = (f: string) => relative(root, f).replaceAll("\\", "/");

function walk(dir: string, exts: readonly string[], skip: readonly string[] = []): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".pio" || e === ".host-build" || skip.includes(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p, exts, skip));
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

const firmwareSources = [
  ...walk(join(lab, "src"), [".cpp", ".h"]),
  ...walk(join(lab, "lib"), [".cpp", ".h"]),
  ...walk(join(lab, "include"), [".h"]),
];
const text = (f: string) => readFileSync(f, "utf8");

describe("firmware secret hygiene", () => {
  it("no log/serial statement mentions key material or the Wi-Fi password", () => {
    expect(firmwareSources.length).toBeGreaterThan(10);
    const printing = /(?:LOGF|Serial\.(?:print|println|printf|write))\s*\([^;]*\);/gs;
    const secretNames = /KEY_HEX|g_key\b|DEVICE_KEY|WIFI_PASSWORD|key_hex|keyHex/;
    for (const f of firmwareSources) {
      for (const stmt of text(f).match(printing) ?? []) {
        expect(stmt, `${rel(f)}: ${stmt}`).not.toMatch(secretNames);
      }
    }
  });

  it("secrets.h is git-ignored and not tracked; no real key is committed", () => {
    const ignore = readFileSync(join(root, ".gitignore"), "utf8");
    expect(ignore).toContain("firmware/esp32-lab/include/secrets.h");
    const tracked = execFileSync("git", ["ls-files", "firmware"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(tracked).not.toContain("firmware/esp32-lab/include/secrets.h");
    // test/ holds public SHA/HMAC standard vectors (not credentials).
    for (const f of tracked.filter(
      (t) => /\.(h|cpp|ini|py|md|mjs)$/.test(t) && !t.includes("/test/"),
    )) {
      const hexes = readFileSync(join(root, f), "utf8").match(/\b[0-9a-fA-F]{64}\b/g) ?? [];
      for (const h of hexes) {
        const allowed =
          /^0+$/.test(h) ||
          // the public S2 known-answer vector (key, body hash, signature) and fingerprints
          /^(0123456789abcdef){4}$/.test(h) ||
          [
            "c743552ae5c7e2458fd98e5ea86d46ea16417ada09810e3d0a7bdb81aaabfa1e",
            "16de8c3f2d864a673edc272cd4b3182ee66ebe70b380e2aacf85fd7e14b1f025",
            "349DFA4058C5E263123B398AE795573C4E1313C83FE68F93556CD5E8031B3C7D",
            "D947432ABDE7B7FA90FC2E6B59101B1280E0E1C7E4E40FA3C6887FFF57A7F4CF",
          ].includes(h);
        expect(allowed, `${f} contains an unexpected 64-hex value`).toBe(true);
      }
    }
  });

  it("the committed secrets template is a placeholder that refuses to send", () => {
    const t = text(join(lab, "include", "secrets.example.h"));
    expect(t).toContain("SYM_SECRETS_ARE_PLACEHOLDER");
    expect(t).toMatch(/SYM_DEVICE_KEY_HEX "0{64}"/);
  });
});

describe("no cloud-to-equipment control", () => {
  const networkSide = ["transport", "net", "uplink", "store"];
  it("network modules never reach the actuator module or its pins", () => {
    for (const name of networkSide) {
      for (const ext of [".cpp", ".h"]) {
        const f = join(lab, "src", name + ext);
        const t = text(f);
        expect(t, rel(f)).not.toMatch(/#include\s+"io\.h"/);
        expect(t, rel(f)).not.toMatch(/PIN_FAN_B|PIN_FAULT_MOTOR|io::|digitalWrite|gpio_set_level/);
      }
    }
  });

  it("only io.cpp drives output pins", () => {
    for (const f of firmwareSources) {
      if (f.endsWith("io.cpp") || f.endsWith("sym_debounce.h")) continue;
      expect(text(f), rel(f)).not.toMatch(/digitalWrite\(|gpio_set_level\(/);
    }
  });

  it("the HTTP response is only classified, never interpreted as a command", () => {
    const t = text(join(lab, "src", "uplink.cpp"));
    expect(t).toContain("classify_response");
    expect(t).not.toMatch(/res\.body\b[^;]*(set_|bench_|fan|motor)/i);
  });

  it("the server side has no actuator or device-command path", () => {
    const dirs = ["apps", "packages", "adapters"].flatMap((g) =>
      readdirSync(join(root, g)).map((p) => join(root, g, p, "src")),
    );
    const bad = /\bactuat|device[_-]?command|fan[_-]?command|setpoint|\bcommand_?device/i;
    for (const d of dirs) {
      for (const f of walk(d, [".ts", ".tsx"])) {
        if (f.endsWith(".test.ts") || f.endsWith(".test.tsx")) continue;
        expect(text(f), rel(f)).not.toMatch(bad);
      }
    }
  });
});

describe("provenance and pin map", () => {
  it("hardware packets are labelled HARDWARE and the firmware never names the simulator", () => {
    expect(text(join(lab, "lib", "symcore", "src", "sym_payload.h"))).toContain(
      'kSourceHardware = "HARDWARE"',
    );
    for (const f of firmwareSources) {
      if (f.endsWith("sym_kat.cpp")) continue; // the public S2 vector body says SIMULATOR
      expect(text(f), rel(f)).not.toMatch(/"SIMULATOR"|SYNTHETIC/);
    }
  });

  it("the locked pin map is unchanged", () => {
    const pins = text(join(lab, "include", "pins.h"));
    const val = (name: string) =>
      Number(new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(pins)?.[1] ?? Number.NaN);
    expect(val("PIN_I2C_SDA")).toBe(21);
    expect(val("PIN_I2C_SCL")).toBe(22);
    expect(val("PIN_FAN_B_MOSFET")).toBe(26);
    expect(val("PIN_FAULT_MOTOR_MOSFET")).toBe(27);
    expect(val("PIN_ROCKER")).toBe(32);
    expect(val("PIN_BUTTON")).toBe(33);
    expect(pins).toMatch(/I2C_ADDR_INA219\s*=\s*0x40/);
    expect(pins).toMatch(/I2C_ADDR_SHT41\s*=\s*0x44/);
    expect(pins).toMatch(/I2C_ADDR_MPU6050\s*=\s*0x68/);
  });

  it("the send path is gated on the shared gate, on the KAT result and on trusted time", () => {
    const up = text(join(lab, "src", "uplink.cpp"));
    expect(up).toContain("send_block_reason");
    expect(up).toContain("net::time_synced()");
    expect(up).toContain("kat_passed");
    const gate = text(join(lab, "lib", "symcore", "src", "sym_gate.cpp"));
    expect(gate).toContain("time_synced");
  });
});
