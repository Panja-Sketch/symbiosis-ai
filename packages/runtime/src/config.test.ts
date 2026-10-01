import { describe, expect, it } from "vitest";
import { selectProvider, resolveExplanationConfig } from "@symbiosis/ai-explanation";
import { RuntimeConfigError, loadExplanationConfig, parseRuntimeConfig } from "./config";

const gcp = {
  SYMBIOSIS_RUNTIME: "gcp",
  GCP_PROJECT_ID: "symbiosis-ai-2026",
  GCP_REGION: "us-central1",
  SYMBIOSIS_EVENTS_TOPIC: "symbiosis-events",
  SYMBIOSIS_EVIDENCE_BUCKET: "symbiosis-ai-2026-evidence",
  FIREBASE_PROJECT_ID: "symbiosis-ai-2026",
};
const worker = {
  ...gcp,
  SYMBIOSIS_WORKER_AUDIENCE: "https://worker.example.run.app",
  SYMBIOSIS_PUSH_SERVICE_ACCOUNT: "push@symbiosis-ai-2026.iam.gserviceaccount.com",
  SYMBIOSIS_SCHEDULER_SERVICE_ACCOUNT: "sched@symbiosis-ai-2026.iam.gserviceaccount.com",
};

describe("runtime configuration fails closed", () => {
  it("defaults to local only off Cloud Run", () => {
    expect(parseRuntimeConfig({}, "api").mode).toBe("local");
    expect(parseRuntimeConfig({ SYMBIOSIS_RUNTIME: "local" }, "api").mode).toBe("local");
  });

  it("refuses to run on Cloud Run unless the runtime is gcp (no silent in-memory deployment)", () => {
    for (const runtime of [undefined, "", "local", "emulator"]) {
      expect(() =>
        parseRuntimeConfig(
          {
            K_SERVICE: "symbiosis-api",
            ...(runtime !== undefined && { SYMBIOSIS_RUNTIME: runtime }),
          },
          "api",
        ),
      ).toThrow(RuntimeConfigError);
    }
    expect(parseRuntimeConfig({ K_SERVICE: "symbiosis-api", ...gcp }, "api").mode).toBe("gcp");
  });

  it("gcp mode names every missing setting and never falls back", () => {
    for (const name of Object.keys(gcp).filter((k) => k !== "SYMBIOSIS_RUNTIME")) {
      const env: Record<string, string> = { ...gcp };
      delete env[name];
      expect(() => parseRuntimeConfig(env, "api"), name).toThrow(new RegExp(name));
    }
    expect(() => parseRuntimeConfig({ SYMBIOSIS_RUNTIME: "gcp" }, "api")).toThrow(
      RuntimeConfigError,
    );
  });

  it("the worker additionally needs its audience and the two service identities", () => {
    expect(() => parseRuntimeConfig(gcp, "worker")).toThrow(/SYMBIOSIS_WORKER_AUDIENCE/);
    const cfg = parseRuntimeConfig(worker, "worker");
    expect(cfg.mode === "gcp" && cfg.worker?.pushServiceAccount).toContain("push@");
  });

  it("rejects an unknown runtime and malformed values", () => {
    expect(() => parseRuntimeConfig({ SYMBIOSIS_RUNTIME: "memory" }, "api")).toThrow(
      /must be local/,
    );
    expect(() =>
      parseRuntimeConfig({ ...gcp, SYMBIOSIS_EVIDENCE_BUCKET: "Bad Bucket!" }, "api"),
    ).toThrow(/invalid format/);
  });

  it("gcp mode forbids emulators, demo identity and a static Vertex token", () => {
    expect(() =>
      parseRuntimeConfig({ ...gcp, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, "api"),
    ).toThrow(/FIRESTORE_EMULATOR_HOST/);
    expect(() =>
      parseRuntimeConfig({ ...gcp, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" }, "api"),
    ).toThrow(/FIREBASE_AUTH_EMULATOR_HOST/);
    expect(() => parseRuntimeConfig({ ...gcp, SYMBIOSIS_ALLOW_DEMO_IDENTITY: "1" }, "api")).toThrow(
      /demo identity/,
    );
    expect(() => parseRuntimeConfig({ ...gcp, VERTEX_ACCESS_TOKEN: "x" }, "api")).toThrow(
      /VERTEX_ACCESS_TOKEN/,
    );
  });

  it("the error never contains a configuration value", () => {
    try {
      parseRuntimeConfig({ ...gcp, VERTEX_ACCESS_TOKEN: "ya29.SECRET-VALUE" }, "api");
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain("SECRET-VALUE");
    }
  });

  it("emulator mode needs the emulator host", () => {
    expect(() => parseRuntimeConfig({ SYMBIOSIS_RUNTIME: "emulator" }, "api")).toThrow(
      /FIRESTORE_EMULATOR_HOST/,
    );
    expect(
      parseRuntimeConfig(
        { SYMBIOSIS_RUNTIME: "emulator", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" },
        "api",
      ).mode,
    ).toBe("emulator");
  });
});

describe("explanation configuration (S9 model correction)", () => {
  it("ships a verified current model on its supported endpoint, not the unverified S8 assumption", () => {
    const c = loadExplanationConfig({});
    expect(c.gemini.model).toBe("gemini-3.1-flash-lite");
    expect(c.gemini.location).toBe("global");
    expect(c.gemini.model).not.toBe("gemini-2.5-flash");
  });

  it("the model and location stay overridable and the default provider stays the template", () => {
    const c = loadExplanationConfig({ GEMINI_MODEL: "m", GEMINI_LOCATION: "us-central1" });
    expect(c.gemini).toMatchObject({ model: "m", location: "us-central1" });
    expect(c.provider).toBe("template");
  });

  it("a workload-identity token supplier enables Gemini without any static token", () => {
    const cfg = resolveExplanationConfig({
      ...JSON.parse(
        JSON.stringify({
          schemaVersion: "explanation-config.v1",
          promptVersion: "p",
          outputSchemaVersion: "o",
          provider: "gemini",
          gemini: {
            model: "m",
            location: "global",
            temperature: 0.1,
            maxOutputTokens: 100,
            timeoutMs: 1000,
          },
          cache: { ttlSeconds: 1, fallbackTtlSeconds: 1 },
        }),
      ),
    });
    expect(selectProvider(cfg, { GCP_PROJECT_ID: "p" }).note).toBe("NOT_CONFIGURED");
    const sel = selectProvider(cfg, { GCP_PROJECT_ID: "p" }, undefined, async () => "adc-token");
    expect(sel.note).toBeUndefined();
    expect(sel.primary.name).toBe("gemini");
  });
});
