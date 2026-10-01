import { beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "@symbiosis/clock";
import {
  InMemoryDeviceKeyStore,
  InMemoryDeviceRegistry,
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  createSyntheticDevRegistry,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { authenticateEdgeRequest } from "./authenticate";
import type { EdgeAuthDeps, EdgeAuthFailureCode, EdgeAuthRequest } from "./authenticate";
import { InMemoryReplayGuard } from "./replay";
import { signEdgeRequest } from "./signing";

const NOW = 1_790_000_000;
const KEY = deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX);
const BODY = new TextEncoder().encode('{"hello":"world"}');

let deps: EdgeAuthDeps;
let clock: ManualClock;
let nonceCounter = 0;

beforeEach(() => {
  clock = new ManualClock(NOW * 1000);
  const { registry, keys } = createSyntheticDevRegistry();
  deps = { registry, keys, replayGuard: new InMemoryReplayGuard(), clock };
  nonceCounter = 0;
});

type Overrides = {
  deviceId?: string;
  keyId?: string;
  key?: Uint8Array;
  timestamp?: number;
  nonce?: string;
  seq?: number;
  path?: string;
  method?: string;
  body?: Uint8Array;
};

function request(o: Overrides = {}): EdgeAuthRequest {
  const path = o.path ?? "/edge/v1/telemetry";
  const body = o.body ?? BODY;
  const headers = signEdgeRequest({
    key: o.key ?? KEY,
    method: o.method ?? "POST",
    path,
    deviceId: o.deviceId ?? "DEV-SIM-001",
    keyId: o.keyId ?? "KEY-SIM-001",
    timestampSeconds: o.timestamp ?? NOW,
    nonce: o.nonce ?? `nonce_${String(++nonceCounter).padStart(12, "0")}`,
    seq: o.seq ?? nonceCounter,
    body,
  });
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method: o.method ?? "POST", path, headers: lower, rawBody: body };
}

async function expectFailure(req: EdgeAuthRequest, code: EdgeAuthFailureCode) {
  const result = await authenticateEdgeRequest(deps, req);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("authenticateEdgeRequest: accepted", () => {
  it("accepts a correctly signed request and returns the trusted identity", async () => {
    const result = await authenticateEdgeRequest(deps, request({ seq: 7 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        deviceId: "DEV-SIM-001",
        keyId: "KEY-SIM-001",
        seq: 7,
        timestampSeconds: NOW,
      });
      expect(result.value.device.organizationId).toBe("ORG-SIM-001");
    }
  });

  it("accepts timestamps exactly at the freshness boundaries", async () => {
    await expect(
      authenticateEdgeRequest(deps, request({ timestamp: NOW - 300, seq: 1 })),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      authenticateEdgeRequest(deps, request({ timestamp: NOW + 60, seq: 2 })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("accepts sequence gaps (monotonic, not contiguous)", async () => {
    await authenticateEdgeRequest(deps, request({ seq: 1 }));
    await expect(authenticateEdgeRequest(deps, request({ seq: 50 }))).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe("authenticateEdgeRequest: signature and identity failures", () => {
  it("rejects a signature made with the wrong key", async () => {
    await expectFailure(request({ key: deviceKeyFromHex("a".repeat(64)) }), "SIGNATURE_MISMATCH");
  });

  it("rejects an unknown device", async () => {
    await expectFailure(request({ deviceId: "DEV-NOPE-999" }), "UNKNOWN_DEVICE");
  });

  it("rejects the wrong key id / version", async () => {
    await expectFailure(request({ keyId: "KEY-SIM-002" }), "UNKNOWN_KEY_ID");
  });

  it("rejects a key id that is not the device's active key even if a key exists for it", async () => {
    const keys = new InMemoryDeviceKeyStore([
      { deviceId: "DEV-SIM-001", keyId: "KEY-SIM-001", key: KEY },
      { deviceId: "DEV-SIM-001", keyId: "KEY-OLD", key: KEY },
    ]);
    deps = { ...deps, keys };
    await expectFailure(request({ keyId: "KEY-OLD" }), "UNKNOWN_KEY_ID");
  });

  it("rejects a disabled device", async () => {
    deps = {
      ...deps,
      registry: new InMemoryDeviceRegistry([{ ...SYNTHETIC_DEV_DEVICE, status: "DISABLED" }]),
    };
    await expectFailure(request(), "DEVICE_DISABLED");
  });

  it("rejects a tampered body", async () => {
    const req = request();
    const tampered = new Uint8Array(req.rawBody);
    tampered[2] = tampered[2]! ^ 1;
    await expectFailure({ ...req, rawBody: tampered }, "SIGNATURE_MISMATCH");
  });

  it("rejects an altered path (signed for telemetry, sent to heartbeat)", async () => {
    const req = request();
    await expectFailure({ ...req, path: "/edge/v1/heartbeat" }, "SIGNATURE_MISMATCH");
  });

  it("rejects an altered method", async () => {
    const req = request();
    await expectFailure({ ...req, method: "PUT" }, "SIGNATURE_MISMATCH");
  });

  it("rejects a malformed signature (non-hex and wrong length)", async () => {
    const req = request();
    await expectFailure(
      { ...req, headers: { ...req.headers, "x-signature": "z".repeat(64) } },
      "MALFORMED_SIGNATURE",
    );
    await expectFailure(
      { ...req, headers: { ...req.headers, "x-signature": "abcd" } },
      "MALFORMED_SIGNATURE",
    );
  });

  it.each(["x-device-id", "x-key-id", "x-timestamp", "x-nonce", "x-seq", "x-signature"])(
    "rejects a request missing %s",
    async (header) => {
      const req = request();
      const headers = { ...req.headers };
      delete headers[header];
      await expectFailure({ ...req, headers }, "MISSING_HEADER");
    },
  );

  it.each([
    ["x-timestamp", "yesterday"],
    ["x-nonce", "short"],
    ["x-seq", "007"],
    ["x-seq", "-1"],
    ["x-seq", "1.5"],
  ])("rejects malformed %s=%s", async (header, value) => {
    const req = request();
    await expectFailure(
      { ...req, headers: { ...req.headers, [header]: value } },
      "MALFORMED_HEADER",
    );
  });
});

describe("authenticateEdgeRequest: freshness", () => {
  it("rejects a stale timestamp", async () => {
    await expectFailure(request({ timestamp: NOW - 301 }), "STALE_TIMESTAMP");
  });

  it("rejects a timestamp too far in the future", async () => {
    await expectFailure(request({ timestamp: NOW + 61 }), "FUTURE_TIMESTAMP");
  });

  it("follows the injected clock", async () => {
    const req = request({ seq: 1 });
    clock.advance(301_000);
    await expectFailure(req, "STALE_TIMESTAMP");
  });
});

describe("authenticateEdgeRequest: replay protection", () => {
  it("rejects a replayed request (same nonce)", async () => {
    const req = request({ seq: 5 });
    expect((await authenticateEdgeRequest(deps, req)).ok).toBe(true);
    await expectFailure(req, "NONCE_REPLAY");
  });

  it("rejects sequence rollback", async () => {
    expect((await authenticateEdgeRequest(deps, request({ seq: 10 }))).ok).toBe(true);
    await expectFailure(request({ seq: 9 }), "SEQUENCE_ROLLBACK");
  });

  it("rejects reuse of the same sequence with a fresh nonce", async () => {
    expect((await authenticateEdgeRequest(deps, request({ seq: 10 }))).ok).toBe(true);
    await expectFailure(request({ seq: 10 }), "SEQUENCE_REUSE");
  });

  it("does not consume nonces or advance sequence on a failed signature", async () => {
    await expectFailure(
      request({ key: deviceKeyFromHex("b".repeat(64)), seq: 1000, nonce: "burned_nonce_000001" }),
      "SIGNATURE_MISMATCH",
    );
    await expect(
      authenticateEdgeRequest(deps, request({ seq: 5, nonce: "burned_nonce_000001" })),
    ).resolves.toMatchObject({ ok: true });
  });

  it("tracks replay state per device/key, not globally", async () => {
    const other = { ...SYNTHETIC_DEV_DEVICE, deviceId: "DEV-SIM-002" };
    deps = {
      ...deps,
      registry: new InMemoryDeviceRegistry([SYNTHETIC_DEV_DEVICE, other]),
      keys: new InMemoryDeviceKeyStore([
        { deviceId: "DEV-SIM-001", keyId: "KEY-SIM-001", key: KEY },
        { deviceId: "DEV-SIM-002", keyId: "KEY-SIM-001", key: KEY },
      ]),
    };
    expect((await authenticateEdgeRequest(deps, request({ seq: 10 }))).ok).toBe(true);
    expect(
      (await authenticateEdgeRequest(deps, request({ deviceId: "DEV-SIM-002", seq: 1 }))).ok,
    ).toBe(true);
  });
});

describe("InMemoryReplayGuard", () => {
  it("prunes nonces older than the retention window", async () => {
    const guard = new InMemoryReplayGuard(100);
    const check = { deviceId: "D", keyId: "K", nonce: "n1", seq: 1, timestampSeconds: 1000 };
    expect((await guard.checkAndRecord({ ...check, nowSeconds: 1000 })).ok).toBe(true);
    // far later, the same nonce is no longer remembered (its timestamp would be stale anyway)
    expect((await guard.checkAndRecord({ ...check, seq: 2, nowSeconds: 1500 })).ok).toBe(true);
  });
});
