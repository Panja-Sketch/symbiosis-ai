import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEdgeHandler } from "../../apps/api/src/edge-handler";
import type { EdgeRequest } from "../../apps/api/src/edge-handler";
import { esp32SourceAdapter, createBenchDeviceRecord } from "@symbiosis/adapter-esp32";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryDeviceKeyStore, InMemoryDeviceRegistry } from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import { InMemoryBus, SequentialIdGenerator } from "@symbiosis/event-bus";
import { normalizeTelemetry } from "@symbiosis/normalization";
import type { EdgeTelemetryPayload } from "@symbiosis/contracts";

/**
 * S10 firmware compatibility: the REAL firmware core (lib/symcore, compiled for the host) signs
 * and serializes requests, and the REAL server code (edge handler, authentication, replay guard,
 * normalization) accepts or rejects them. This is the hardware-independent half of the S10
 * acceptance; it does not replace the physical H0-H8 checks.
 */
// Each case spawns the compiled firmware CLI; process start-up is slow on loaded machines.
vi.setConfig({ testTimeout: 60_000 });

const root = join(import.meta.dirname, "..", "..");
const lab = join(root, "firmware", "esp32-lab");
const exe = join(lab, ".host-build", process.platform === "win32" ? "sym_cli.exe" : "sym_cli");

let compilerAvailable = false;
let buildDetail = "";
beforeAll(() => {
  const r = spawnSync("node", [join(lab, "test", "host", "run.mjs"), "--build-only"], {
    encoding: "utf8",
  });
  compilerAvailable = r.status === 0 && existsSync(exe);
  buildDetail = `${r.stdout}${r.stderr}`.slice(0, 2000);
  if (!compilerAvailable && process.env.SYMBIOSIS_REQUIRE_FIRMWARE_HOST === "1") {
    throw new Error(`firmware host build required but unavailable: ${buildDetail}`);
  }
  if (!compilerAvailable) {
    console.warn(
      "[firmware-compat] SKIPPED: no C++ compiler (set SYM_CXX). " +
        "Set SYMBIOSIS_REQUIRE_FIRMWARE_HOST=1 to make this a failure.",
    );
  }
}, 600_000);

const NOW = 1_790_000_000;
const DEVICE = "DEV-PHX-BENCH-001";
const KEY_ID = "KEY-PHX-001";
const tmp = mkdtempSync(join(tmpdir(), "fwcompat-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cli = (...args: string[]) => execFileSync(exe, args, { encoding: "buffer" });
const cliText = (...args: string[]) =>
  cli(...args)
    .toString("utf8")
    .trim();

function build() {
  const key = randomBytes(32);
  const registry = new InMemoryDeviceRegistry([
    createBenchDeviceRecord({
      deviceId: DEVICE,
      keyId: KEY_ID,
      organizationId: "ORG-SIM-001",
      facilityId: "FAC-SIM-001",
    }),
  ]);
  const bus = new InMemoryBus();
  const handle = createEdgeHandler({
    registry,
    keys: new InMemoryDeviceKeyStore([{ deviceId: DEVICE, keyId: KEY_ID, key }]),
    replayGuard: new InMemoryReplayGuard(),
    bus,
    clock: new ManualClock(NOW * 1000),
    ids: new SequentialIdGenerator(),
  });
  let n = 0;
  const nonce = () => `fw_nonce_${String(++n).padStart(8, "0")}`;
  let bodyFile = 0;

  /** Signs with the FIRMWARE implementation; the body is the exact bytes that will be sent. */
  function sign(
    path: string,
    body: Buffer,
    o: { key?: Buffer; ts?: number; nonce?: string; seq: number },
  ): EdgeRequest {
    const file = join(tmp, `body-${++bodyFile}.bin`);
    writeFileSync(file, body);
    const ts = o.ts ?? NOW;
    const nn = o.nonce ?? nonce();
    const out = JSON.parse(
      cliText(
        "sign",
        (o.key ?? key).toString("hex"),
        "POST",
        path,
        String(ts),
        nn,
        String(o.seq),
        file,
      ),
    ) as { bodySha256: string; signature: string };
    return {
      method: "POST",
      target: path,
      headers: {
        "x-device-id": DEVICE,
        "x-key-id": KEY_ID,
        "x-timestamp": String(ts),
        "x-nonce": nn,
        "x-seq": String(o.seq),
        "x-signature": out.signature,
      },
      rawBody: body,
    };
  }
  return { key, registry, bus, handle, sign, nonce };
}

const telemetryBody = (epoch = NOW - 5) =>
  cli("telemetry", DEVICE, "0.1.0+gtest123", String(epoch), "4.2", "55.1", "0.18", "312.0", "0");

describe("firmware core vs real server code", () => {
  const skip = () => !compilerAvailable;

  it("SHA-256 and HMAC-SHA256 agree with Node crypto across block boundaries", (ctx) => {
    if (skip()) return ctx.skip();
    const lengths = [
      0, 1, 2, 31, 32, 33, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 500, 1000,
    ];
    for (const len of lengths) {
      const data = randomBytes(len);
      expect(cliText("sha256", data.toString("hex"))).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
      for (const keyLen of [1, 32, 65]) {
        const k = randomBytes(keyLen);
        expect(cliText("hmac", k.toString("hex"), data.toString("hex"))).toBe(
          createHmac("sha256", k).update(data).digest("hex"),
        );
      }
    }
  });

  it("firmware known-answer self-test passes", (ctx) => {
    if (skip()) return ctx.skip();
    expect(cliText("selftest")).toBe("PASS ok");
  });

  it("accepts firmware-signed telemetry and produces correctly mapped HARDWARE observations", async (ctx) => {
    if (skip()) return ctx.skip();
    const s = build();
    const body = telemetryBody();
    const res = await s.handle(s.sign("/edge/v1/telemetry", body, { seq: 1 }));
    expect(res.status).toBe(202);

    const authenticated = s.bus
      .history()
      .find((e) => e.event_type === "telemetry.authenticated.v1");
    const p = authenticated?.payload as unknown as {
      assetId: string;
      assetMapping: Parameters<typeof normalizeTelemetry>[2]["assetMapping"];
      expectedSignals: Parameters<typeof normalizeTelemetry>[2]["expectedSignals"];
      telemetry: EdgeTelemetryPayload;
    };
    expect(p.telemetry.source).toBe("HARDWARE");
    const { observations, rejectedReadings } = normalizeTelemetry(esp32SourceAdapter, p.telemetry, {
      organizationId: "ORG-SIM-001",
      facilityId: "FAC-SIM-001",
      assetId: p.assetId,
      ...(p.assetMapping !== undefined && { assetMapping: p.assetMapping }),
      deviceId: DEVICE,
      expectedSignals: p.expectedSignals,
      receivedAt: "2026-09-30T00:00:00.000Z",
    });
    expect(rejectedReadings).toEqual([]);
    const by = Object.fromEntries(observations.map((o) => [o.signal, o]));
    expect(by.vibration_rms).toMatchObject({ assetId: "AST-SIM-FAN-A", unit: "m/s2" });
    expect(by.vibration_rms?.value).toBeCloseTo(0.18, 4);
    expect(by.current).toMatchObject({ assetId: "AST-SIM-FAN-A", unit: "A" });
    expect(by.current?.value).toBeCloseTo(0.312, 6);
    expect(by.temperature).toMatchObject({ assetId: "AST-SIM-ZONE-1" });
    expect(by.relative_humidity).toMatchObject({ assetId: "AST-SIM-ZONE-1" });
    expect(by.equipment_running).toMatchObject({ assetId: "AST-SIM-FAN-B", value: false });
    expect(observations.every((o) => o.sourceType === "HARDWARE")).toBe(true);
    expect(observations.every((o) => o.deviceId === DEVICE)).toBe(true);
    expect(by.load_percent).toBeUndefined();
  });

  it("accepts a firmware heartbeat and records its health", async (ctx) => {
    if (skip()) return ctx.skip();
    const s = build();
    for (const [i, health] of (["HEALTHY", "DEGRADED", "FAULT"] as const).entries()) {
      const body = cli("heartbeat", DEVICE, "0.1.0+gtest123", String(NOW - 1), health);
      const res = await s.handle(s.sign("/edge/v1/heartbeat", body, { seq: i + 1 }));
      expect(res.status).toBe(200);
      expect((await s.registry.get(DEVICE))?.health).toBe(health);
    }
  });

  it("security matrix with firmware-signed requests", async (ctx) => {
    if (skip()) return ctx.skip();
    const s = build();
    const path = "/edge/v1/telemetry";
    const code = (r: { body: unknown }) => (r.body as { error?: { code?: string } }).error?.code;

    // correct request accepted
    const good = s.sign(path, telemetryBody(), { seq: 10 });
    expect((await s.handle(good)).status).toBe(202);

    // intentional resend of the exact same signed request: replay rejected
    const replay = await s.handle(good);
    expect(replay.status).toBe(409);
    expect(["NONCE_REPLAY", "SEQUENCE_REUSE"]).toContain(code(replay));

    // wrong device key
    const wrongKey = await s.handle(
      s.sign(path, telemetryBody(), { seq: 11, key: randomBytes(32) }),
    );
    expect([wrongKey.status, code(wrongKey)]).toEqual([401, "SIGNATURE_MISMATCH"]);

    // altered body (signed one body, sent another)
    const signedReq = s.sign(path, telemetryBody(), { seq: 12 });
    const altered = await s.handle({ ...signedReq, rawBody: telemetryBody(NOW - 4) });
    expect([altered.status, code(altered)]).toEqual([401, "SIGNATURE_MISMATCH"]);

    // old / future timestamps
    const old = await s.handle(s.sign(path, telemetryBody(), { seq: 13, ts: NOW - 301 }));
    expect([old.status, code(old)]).toEqual([401, "STALE_TIMESTAMP"]);
    const future = await s.handle(s.sign(path, telemetryBody(), { seq: 14, ts: NOW + 61 }));
    expect([future.status, code(future)]).toEqual([401, "FUTURE_TIMESTAMP"]);

    // duplicate nonce with a fresh sequence
    const dupNonce = await s.handle(
      s.sign(path, telemetryBody(), { seq: 20, nonce: "dup_nonce_00000001" }),
    );
    expect(dupNonce.status).toBe(202);
    const dupNonce2 = await s.handle(
      s.sign(path, telemetryBody(), { seq: 21, nonce: "dup_nonce_00000001" }),
    );
    expect([dupNonce2.status, code(dupNonce2)]).toEqual([409, "NONCE_REPLAY"]);

    // reused and rolled-back sequence
    const reuse = await s.handle(s.sign(path, telemetryBody(), { seq: 21 }));
    expect(reuse.status).toBe(202); // 21 was only attempted with a bad nonce: never recorded
    const reuse2 = await s.handle(s.sign(path, telemetryBody(), { seq: 21 }));
    expect([reuse2.status, code(reuse2)]).toEqual([409, "SEQUENCE_REUSE"]);
    const rollback = await s.handle(s.sign(path, telemetryBody(), { seq: 5 }));
    expect([rollback.status, code(rollback)]).toEqual([409, "SEQUENCE_ROLLBACK"]);

    // nothing leaks the key
    const all = JSON.stringify([replay.body, wrongKey.body, altered.body, rollback.body]);
    expect(all).not.toContain(s.key.toString("hex"));
  });

  it("a gap in sequence numbers (reboot reservation, outage) is accepted", async (ctx) => {
    if (skip()) return ctx.skip();
    const s = build();
    expect(
      (await s.handle(s.sign("/edge/v1/telemetry", telemetryBody(), { seq: 100 }))).status,
    ).toBe(202);
    expect(
      (await s.handle(s.sign("/edge/v1/telemetry", telemetryBody(), { seq: 164 }))).status,
    ).toBe(202);
  });
});
