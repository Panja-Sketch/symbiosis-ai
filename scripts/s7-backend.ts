import { createServer } from "node:http";
import type { Server } from "node:http";
import {
  FakeGemini,
  GeminiExplanationProvider,
  TemplateExplanationProvider,
} from "@symbiosis/ai-explanation";
import type { ExplanationProvider, FakeGeminiMode } from "@symbiosis/ai-explanation";
import { SimulatorClient, scenarioReadings } from "@symbiosis/adapter-simulator";
import type { ScenarioName } from "@symbiosis/adapter-simulator";
import { ManualClock } from "@symbiosis/clock";
import {
  SYNTHETIC_DEV_DEVICE,
  SYNTHETIC_DEV_KEY_HEX,
  deviceKeyFromHex,
} from "@symbiosis/device-registry";
import { createLocalRuntime } from "./local-runtime";
import type { LocalRuntime } from "./local-runtime";

/**
 * Deterministic backend for the S7 browser tests and `pnpm smoke:s7`.
 *
 * It is the REAL local runtime (same API, worker, verification, evidence and consent code as
 * `pnpm dev`) with a simulated clock, plus a tiny control port that does only what a person
 * cannot do in a browser: let simulated time pass and feed the simulator's signed telemetry
 * (detect a hazard, complete a verification window, let the hazard return). It contains no
 * domain logic and the web app never talks to the control port. Not part of the product.
 */
export const S7_ORG = SYNTHETIC_DEV_DEVICE.organizationId;

export type S7Backend = {
  readonly apiUrl: string;
  readonly controlUrl: string;
  runtime(): LocalRuntime;
  /** Normal baseline, then persistent compound deterioration: one detected case. */
  detect(): Promise<string>;
  /** Scheduler pass, then 25 trusted samples of `scenario`, then another pass. */
  verify(scenario?: ScenarioName): Promise<unknown>;
  /** No post-action readings arrive and the window ends: an inconclusive verification. */
  expire(): Promise<unknown>;
  /** The hazard returns after a verified improvement. */
  recur(): Promise<void>;
  /** Explanation provider for browser tests: the template, or the real Gemini adapter over a scripted fake endpoint. */
  setAi(mode: "template" | FakeGeminiMode): void;
  /** A fresh, empty world on the same ports. */
  reset(): Promise<void>;
  close(): Promise<void>;
};

export async function startS7Backend(
  options: { readonly apiPort?: number; readonly controlPort?: number } = {},
): Promise<S7Backend> {
  const apiPort = options.apiPort ?? 8791;
  const controlPort = options.controlPort ?? 8792;

  let clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
  let current: LocalRuntime;
  const fakeGemini = new FakeGemini();
  const aiProvider = (mode: "template" | FakeGeminiMode): ExplanationProvider => {
    if (mode === "template") return new TemplateExplanationProvider();
    fakeGemini.mode = mode;
    return new GeminiExplanationProvider(
      {
        projectId: "demo-project",
        location: "us-central1",
        model: "gemini-2.5-flash",
        temperature: 0.1,
        maxOutputTokens: 1500,
        timeoutMs: 1000,
      },
      async () => "fake-local-token",
      fakeGemini.fetch,
    );
  };
  let client: SimulatorClient;

  async function boot(): Promise<void> {
    clock = new ManualClock(Date.parse("2026-10-01T00:00:00Z"));
    current = await createLocalRuntime({ clock, port: apiPort, consoleSink: () => {} });
    client = new SimulatorClient({
      baseUrl: current.server.baseUrl,
      deviceId: SYNTHETIC_DEV_DEVICE.deviceId,
      keyId: SYNTHETIC_DEV_DEVICE.activeKeyId,
      key: deviceKeyFromHex(SYNTHETIC_DEV_KEY_HEX),
      clock,
      initialSeq: 1,
    });
    // A pooled connection to the previous (closed) server can fail once; retry briefly.
    for (let attempt = 1; ; attempt++) {
      try {
        await client.sendHeartbeat("HEALTHY");
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  async function send(scenario: ScenarioName, count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const readings = scenarioReadings(scenario, i);
      const res = await client.sendTelemetry(readings).catch(() => client.sendTelemetry(readings));
      if (res.status !== 202) throw new Error(`telemetry rejected (${res.status})`);
      clock.advance(5000);
    }
  }

  const backend: S7Backend = {
    apiUrl: `http://127.0.0.1:${apiPort}`,
    controlUrl: `http://127.0.0.1:${controlPort}`,
    runtime: () => current,
    async detect() {
      await send("normal", 25);
      await send("compound-outdoor-heat", 3);
      const [c] = await current.cases.list(S7_ORG);
      if (c === undefined) throw new Error("no case was detected");
      return c.caseId;
    },
    async verify(scenario = "normal") {
      await current.tick(); // verification starts for a reported action
      await send(scenario, 25);
      return current.tick(); // the window has data; the verification completes
    },
    async expire() {
      await current.tick();
      clock.advance(200_000);
      return current.tick();
    },
    async recur() {
      await send("normal", 3);
      await send("compound-outdoor-heat", 3);
    },
    setAi(mode) {
      current.explanations.setPrimary(aiProvider(mode));
    },
    async reset() {
      await current.close();
      await boot();
    },
    async close() {
      await new Promise<void>((done) => {
        control.close(() => done());
        control.closeAllConnections();
      });
      await current.close();
    },
  };

  const control: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let body: Record<string, unknown> = {};
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          return reply(400, { error: "malformed body" });
        }
        try {
          if (req.method === "GET" && url.pathname === "/control/health") {
            return reply(200, { ok: true });
          }
          if (req.method !== "POST") return reply(405, { error: "POST only" });
          if (url.pathname === "/control/ai") {
            backend.setAi((body.mode as "template" | FakeGeminiMode | undefined) ?? "template");
            return reply(200, { ok: true });
          }
          if (url.pathname === "/control/ai-log") {
            return reply(200, { records: current.explanationLog.list() });
          }
          if (url.pathname === "/control/reset") {
            await backend.reset();
            return reply(200, { ok: true });
          }
          if (url.pathname === "/control/detect") {
            return reply(200, { caseId: await backend.detect() });
          }
          if (url.pathname === "/control/verify") {
            const scenario = (body.scenario as ScenarioName | undefined) ?? "normal";
            return reply(200, await backend.verify(scenario));
          }
          if (url.pathname === "/control/expire") {
            return reply(200, await backend.expire());
          }
          if (url.pathname === "/control/recur") {
            await backend.recur();
            return reply(200, { ok: true });
          }
          return reply(404, { error: "unknown control route" });
        } catch (e) {
          return reply(500, { error: e instanceof Error ? e.message : "failed" });
        }
      })();
    });
  });

  await boot();
  await new Promise<void>((resolve, reject) => {
    control.once("error", reject);
    control.listen(controlPort, "127.0.0.1", () => resolve());
  });
  return backend;
}

// Run directly (Playwright web server): `tsx scripts/s7-backend.ts`.
const entry = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (entry.endsWith("scripts/s7-backend.ts")) {
  const backend = await startS7Backend({
    apiPort: Number(process.env.S7_API_PORT ?? 8791),
    controlPort: Number(process.env.S7_CONTROL_PORT ?? 8792),
  });
  console.log(`[s7-backend] api ${backend.apiUrl}  control ${backend.controlUrl}`);
  const stop = () => void backend.close();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
