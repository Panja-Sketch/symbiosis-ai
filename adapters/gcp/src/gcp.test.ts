import { describe, expect, it } from "vitest";
import type { PlatformEvent } from "@symbiosis/contracts";
import { createEdgeHandler } from "../../../apps/api/src/edge-handler";
import { ManualClock } from "@symbiosis/clock";
import { InMemoryDeviceRegistry, InMemoryDeviceKeyStore } from "@symbiosis/device-registry";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { InMemoryReplayGuard } from "@symbiosis/edge-security";
import { SequentialIdGenerator } from "@symbiosis/event-bus";
import { InMemoryActorDirectory, SYNTHETIC_ACTORS } from "@symbiosis/tenancy";
import { FirebaseIdentityResolver } from "./auth/firebase";
import { MemoryLogger, redactFields, scrubString } from "./logger";
import { PubSubBus, createPushHandler, decodePushBody } from "./pubsub/bus";
import type { TopicPublisher } from "./pubsub/bus";
import { GcsEvidenceObjectStore } from "./storage/evidence";
import type { ObjectClient } from "./storage/evidence";
import { SecretManagerDeviceKeyStore, deviceKeySecretId } from "./secrets/device-keys";

const event = (over: Partial<PlatformEvent> = {}): PlatformEvent =>
  ({
    event_id: "EVT-1",
    event_type: "case.created.v1",
    schema_version: "1.0",
    correlation_id: "CORR-1",
    causation_id: null,
    organization_id: "ORG-A",
    facility_id: "FAC-1",
    occurred_at: "2026-10-01T00:00:00.000Z",
    producer: "api",
    payload: { caseId: "CASE-1" },
    ...over,
  }) as PlatformEvent;

const pushBody = (e: unknown): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      message: { data: Buffer.from(JSON.stringify(e)).toString("base64"), messageId: "m1" },
      subscription: "projects/p/subscriptions/s",
    }),
  );

describe("PubSubBus", () => {
  it("publishes the unchanged envelope with diagnostic attributes", async () => {
    const sent: { data: string; attributes: Record<string, string> }[] = [];
    const topic: TopicPublisher = {
      publish: async (data, attributes) => {
        sent.push({ data: data.toString("utf8"), attributes });
        return "id";
      },
    };
    const e = event();
    await new PubSubBus(topic).publish(e);
    expect(JSON.parse(sent[0]?.data ?? "")).toEqual(e);
    expect(sent[0]?.attributes).toMatchObject({
      event_type: "case.created.v1",
      organization_id: "ORG-A",
    });
  });

  it("a failed publish rejects: no false success", async () => {
    const bus = new PubSubBus({
      publish: async () => {
        throw new Error("UNAVAILABLE");
      },
    });
    await expect(bus.publish(event())).rejects.toThrow(/UNAVAILABLE/);
  });

  it("publish never runs handlers (delivery is the subscription's job)", async () => {
    let ran = 0;
    const bus = new PubSubBus({ publish: async () => "id" });
    bus.subscribe("case.created.v1", () => {
      ran += 1;
    });
    await bus.publish(event());
    expect(ran).toBe(0);
    await bus.dispatch(event());
    expect(ran).toBe(1);
  });

  it("dispatch attempts every handler and throws if any failed (so the message is redelivered)", async () => {
    const bus = new PubSubBus({ publish: async () => "id" });
    const calls: string[] = [];
    bus.subscribe("case.created.v1", () => {
      calls.push("a");
      throw new Error("boom");
    });
    bus.subscribe("case.created.v1", () => {
      calls.push("b");
    });
    await expect(bus.dispatch(event())).rejects.toThrow(/1 handler/);
    expect(calls).toEqual(["a", "b"]);
  });
});

describe("push delivery handler", () => {
  const make = (over: { authorized?: boolean; processed?: Set<string>; fail?: boolean } = {}) => {
    const processed = over.processed ?? new Set<string>();
    const bus = new PubSubBus({ publish: async () => "id" });
    let handled = 0;
    bus.subscribe("case.created.v1", () => {
      handled += 1;
      if (over.fail === true) throw new Error("handler failed");
    });
    const logger = new MemoryLogger();
    const handler = createPushHandler({
      bus,
      logger,
      inbox: {
        isProcessed: async (id) => processed.has(id),
        markProcessed: async (id) => {
          processed.add(id);
        },
      },
      verifyCaller: async () => over.authorized !== false,
    });
    const send = (body: Uint8Array) =>
      handler({
        method: "POST",
        target: "/pubsub/push",
        headers: { authorization: "Bearer x" },
        rawBody: body,
      });
    return { send, processed, logger, handled: () => handled };
  };

  it("acknowledges (204) after every handler succeeded and marks the event processed", async () => {
    const t = make();
    expect((await t.send(pushBody(event()))).status).toBe(204);
    expect(t.handled()).toBe(1);
    expect(t.processed.has("EVT-1")).toBe(true);
  });

  it("a duplicate delivery of a processed event is acknowledged without running handlers", async () => {
    const t = make({ processed: new Set(["EVT-1"]) });
    expect((await t.send(pushBody(event()))).status).toBe(204);
    expect(t.handled()).toBe(0);
  });

  it("a failing handler is NOT acknowledged (500) and the event is not marked processed", async () => {
    const t = make({ fail: true });
    expect((await t.send(pushBody(event()))).status).toBe(500);
    expect(t.processed.size).toBe(0);
  });

  it("an unauthorized caller is rejected before anything is read or run", async () => {
    const t = make({ authorized: false });
    expect((await t.send(pushBody(event()))).status).toBe(401);
    expect(t.handled()).toBe(0);
  });

  it("a malformed message is not acknowledged (it ends in the dead-letter topic)", async () => {
    const t = make();
    expect((await t.send(new TextEncoder().encode("{}"))).status).toBe(400);
    expect((await t.send(pushBody({ event_id: "x" }))).status).toBe(400);
    expect(t.handled()).toBe(0);
  });

  it("decodePushBody validates the envelope", () => {
    expect(decodePushBody(pushBody(event())).ok).toBe(true);
    expect(decodePushBody(pushBody(event({ schema_version: "9.9" } as never))).ok).toBe(false);
    expect(decodePushBody(pushBody({ ...event(), producer: "browser" })).ok).toBe(false);
    expect(decodePushBody(pushBody({ ...event(), payload: null })).ok).toBe(false);
  });
});

class FakeObjects implements ObjectClient {
  readonly store = new Map<string, string>();
  corruptOnWrite = false;
  failWrites = false;
  async createIfAbsent(name: string, content: string): Promise<boolean> {
    if (this.failWrites) throw new Error("storage unavailable");
    if (this.store.has(name)) return false;
    this.store.set(name, this.corruptOnWrite ? `${content}x` : content);
    return true;
  }
  async read(name: string): Promise<string | undefined> {
    return this.store.get(name);
  }
}

describe("GcsEvidenceObjectStore", () => {
  const key = "evidence/ORG-A/EVP-1.json";

  it("never overwrites an existing object", async () => {
    const objects = new FakeObjects();
    const s = new GcsEvidenceObjectStore(objects);
    expect(await s.putIfAbsent(key, "first")).toBe(true);
    expect(await s.putIfAbsent(key, "second")).toBe(false);
    expect(await s.get(key)).toBe("first");
  });

  it("rejects keys that are not evidence keys (no traversal, no untrusted names)", async () => {
    const s = new GcsEvidenceObjectStore(new FakeObjects());
    for (const bad of [
      "../x",
      "evidence/../x.json",
      "evidence/ORG-A/a b.json",
      "other/ORG-A/x.json",
      "evidence/ORG-A/x.txt",
    ]) {
      await expect(s.putIfAbsent(bad, "c")).rejects.toThrow(/not a valid evidence key/);
      expect(await s.get(bad)).toBeUndefined();
    }
  });

  it("a storage failure throws (the evidence service then reports STORAGE_FAILURE, never success)", async () => {
    const objects = new FakeObjects();
    objects.failWrites = true;
    await expect(new GcsEvidenceObjectStore(objects).putIfAbsent(key, "c")).rejects.toThrow(
      /unavailable/,
    );
  });

  it("read-back verification catches an object whose bytes differ from what was meant to be stored", async () => {
    const objects = new FakeObjects();
    objects.corruptOnWrite = true;
    await expect(new GcsEvidenceObjectStore(objects).putIfAbsent(key, "content")).rejects.toThrow(
      /read-back/,
    );
  });

  it("a missing object is undefined, not an error", async () => {
    expect(await new GcsEvidenceObjectStore(new FakeObjects()).get(key)).toBeUndefined();
  });
});

describe("SecretManagerDeviceKeyStore", () => {
  const hex = "ab".repeat(32);
  it("reads a key, caches it for the TTL and names secrets by device and key id only", async () => {
    const asked: string[] = [];
    let now = 0;
    const store = new SecretManagerDeviceKeyStore(
      {
        accessLatest: async (id) => {
          asked.push(id);
          return `${hex}\n`;
        },
      },
      1000,
      () => now,
    );
    expect(await store.getKey("DEV-1", "KEY-1")).toEqual(deviceKeyFromHex(hex));
    await store.getKey("DEV-1", "KEY-1");
    expect(asked).toEqual([deviceKeySecretId("DEV-1", "KEY-1")]);
    now = 2000;
    await store.getKey("DEV-1", "KEY-1");
    expect(asked).toHaveLength(2);
  });

  it("unknown secret -> undefined; unsafe ids never reach Secret Manager", async () => {
    const asked: string[] = [];
    const store = new SecretManagerDeviceKeyStore({
      accessLatest: async (id) => {
        asked.push(id);
        return undefined;
      },
    });
    expect(await store.getKey("DEV-1", "KEY-1")).toBeUndefined();
    expect(await store.getKey("../x", "KEY-1")).toBeUndefined();
    expect(await store.getKey("DEV-1", "a/b")).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  it("a malformed secret or an unreachable Secret Manager throws (fail closed)", async () => {
    await expect(
      new SecretManagerDeviceKeyStore({ accessLatest: async () => "not-hex" }).getKey(
        "DEV-1",
        "KEY-1",
      ),
    ).rejects.toThrow();
    await expect(
      new SecretManagerDeviceKeyStore({
        accessLatest: async () => {
          throw new Error("UNAVAILABLE");
        },
      }).getKey("DEV-1", "KEY-1"),
    ).rejects.toThrow(/UNAVAILABLE/);
  });
});

describe("signed ingestion fails closed on infrastructure failure", () => {
  const body = new TextEncoder().encode("{}");
  const make = (
    keys: { getKey(d: string, k: string): Promise<Uint8Array | undefined> },
    bus: { publish(e: PlatformEvent): Promise<void> },
  ) =>
    createEdgeHandler({
      registry: new InMemoryDeviceRegistry([SYNTHETIC_DEV_DEVICE]),
      keys,
      replayGuard: new InMemoryReplayGuard(),
      bus: { ...bus, subscribe: () => () => {} },
      clock: new ManualClock(Date.parse("2026-10-01T00:00:00Z")),
      ids: new SequentialIdGenerator(),
    });

  it("an unavailable secret never yields an accepted request", async () => {
    let published = 0;
    const handler = make(
      {
        getKey: async () => {
          throw new Error("secret unavailable");
        },
      },
      {
        publish: async () => {
          published += 1;
        },
      },
    );
    const headers = {
      "x-device-id": "DEV-SIM-001",
      "x-key-id": "KEY-SIM-001",
      "x-timestamp": "1790812800",
      "x-seq": "1",
      "x-nonce": "nonce-aaaaaaaaaaaaaaaa",
      "x-signature": "00".repeat(32),
    };
    await expect(
      handler({ method: "POST", target: "/edge/v1/telemetry", headers, rawBody: body }),
    ).rejects.toThrow(/secret unavailable/);
    expect(published).toBe(0);
    void new InMemoryDeviceKeyStore([
      { deviceId: "x", keyId: "y", key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX) },
    ]);
  });
});

describe("FirebaseIdentityResolver", () => {
  const directory = new InMemoryActorDirectory(SYNTHETIC_ACTORS);
  const links = {
    actorIdForUid: async (uid: string) => (uid === "uid-mgr" ? "USR-FACILITY-MGR-001" : undefined),
  };
  const resolver = (verify: (t: string) => Promise<{ uid: string }>, dir = directory, l = links) =>
    new FirebaseIdentityResolver({ verify, links: l, directory: dir });
  const ok = async () => ({ uid: "uid-mgr" });

  it("maps a verified UID to the directory actor: organization and roles come from the record", async () => {
    const actor = await resolver(ok).resolve({
      headers: {
        authorization: "Bearer good.token.value",
        // Everything below is client-supplied and must be ignored.
        "x-demo-actor-id": "USR-RISK-ENGINEER-001",
        "x-organization-id": "ORG-INS-001",
        "x-roles": "ORG_ADMIN",
      },
      query: new URLSearchParams("actor=USR-ORG-ADMIN-001&organizationId=ORG-INS-001"),
    });
    expect(actor).toMatchObject({
      actorId: "USR-FACILITY-MGR-001",
      organizationId: "ORG-SIM-001",
      roles: ["FACILITY_MANAGER"],
    });
  });

  it("rejects forged, expired and wrong-project tokens (the verifier throws)", async () => {
    for (const code of [
      "auth/argument-error",
      "auth/id-token-expired",
      "auth/invalid-credential",
    ]) {
      const r = resolver(async () => {
        throw Object.assign(new Error("x"), { code });
      });
      expect(await r.resolve({ headers: { authorization: "Bearer a.b.c" } })).toBeUndefined();
    }
  });

  it("rejects missing, malformed and oversized authorization headers without calling the verifier", async () => {
    let called = 0;
    const r = resolver(async () => {
      called += 1;
      return { uid: "uid-mgr" };
    });
    expect(await r.resolve({ headers: {} })).toBeUndefined();
    expect(await r.resolve({ headers: { authorization: "Basic abc" } })).toBeUndefined();
    expect(await r.resolve({ headers: { authorization: "Bearer " } })).toBeUndefined();
    expect(
      await r.resolve({ headers: { authorization: `Bearer ${"a".repeat(9000)}` } }),
    ).toBeUndefined();
    expect(called).toBe(0);
  });

  it("a valid token for a UID without an actor link is unauthorized", async () => {
    expect(
      await resolver(async () => ({ uid: "uid-stranger" })).resolve({
        headers: { authorization: "Bearer a.b.c" },
      }),
    ).toBeUndefined();
  });

  it("a linked actor missing from the directory is unauthorized", async () => {
    const r = resolver(ok, new InMemoryActorDirectory([]));
    expect(await r.resolve({ headers: { authorization: "Bearer a.b.c" } })).toBeUndefined();
  });

  it("an unavailable directory denies instead of guessing", async () => {
    const broken = {
      get: async () => {
        throw new Error("firestore unavailable");
      },
      findByRole: async () => undefined,
    };
    expect(
      await resolver(ok, broken as never).resolve({ headers: { authorization: "Bearer a.b.c" } }),
    ).toBeUndefined();
  });

  it("never logs the token", async () => {
    const logger = new MemoryLogger();
    const r = new FirebaseIdentityResolver({
      verify: async () => {
        throw new Error("bad token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln");
      },
      links,
      directory,
      logger,
    });
    await r.resolve({
      headers: { authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln" },
    });
    expect(JSON.stringify(logger.entries)).not.toContain("eyJ");
  });
});

describe("structured logging never leaks secrets", () => {
  it("redacts credential-named fields and scrubs token-like values", () => {
    const hex = "0123456789abcdef".repeat(4);
    const out = redactFields({
      authorization: "Bearer abcdefghijklmnop",
      idToken: "x",
      deviceKey: hex,
      key: hex,
      password: "p",
      note: `see Bearer abcdefghijklmnop and ${hex} and eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln`,
      keyId: "KEY-SIM-001",
      nested: { secretValue: "s", fine: 1 },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain("abcdefghijklmnop");
    expect(text).not.toContain(hex);
    expect(text).not.toContain("eyJ");
    // Credential-NAMED fields are replaced even when the value looks harmless.
    const named = redactFields({
      password: "hunter2",
      idToken: "opaque",
      secretValue: "plain",
      key: "abc",
    });
    expect(Object.values(named)).toEqual(["[redacted]", "[redacted]", "[redacted]", "[redacted]"]);
    expect(out.keyId).toBe("KEY-SIM-001");
    expect((out.nested as Record<string, unknown>).fine).toBe(1);
    expect(scrubString("Bearer abcdefghijkl")).toBe("Bearer [redacted]");
  });
});
