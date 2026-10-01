import { templateExplanation } from "./template";
import type { ExplanationContext } from "./types";
import type { FetchLike } from "./gemini";

/**
 * A scripted stand-in for the Vertex AI endpoint, used by tests, the browser tests and the smoke
 * test so the REAL Gemini adapter code runs end to end without a network or a credential. It
 * answers in Gemini's response envelope and records every request so tests can inspect exactly what
 * would have been sent.
 */

export type FakeGeminiMode =
  | "ok"
  | "malformed-json"
  | "bad-schema"
  | "extra-key"
  | "unknown-fact"
  | "contradict-result"
  | "invented-number"
  | "invented-action"
  | "claims-resolved"
  | "follow-injection"
  | "quota"
  | "unavailable"
  | "auth"
  | "timeout"
  | "truncated";

export type RecordedCall = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly system: string;
  readonly user: string;
  readonly context: ExplanationContext;
};

export class FakeGemini {
  readonly calls: RecordedCall[] = [];
  constructor(public mode: FakeGeminiMode = "ok") {}

  readonly fetch: FetchLike = async (url, init) => {
    const body = String(init.body ?? "");
    const parsed = JSON.parse(body) as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    };
    const user = parsed.contents[0]?.parts[0]?.text ?? "";
    const system = parsed.systemInstruction.parts[0]?.text ?? "";
    const m = /TRUSTED_FACTS_BEGIN\n([\s\S]*?)\nTRUSTED_FACTS_END/.exec(user);
    const trusted = JSON.parse(m?.[1] ?? "{}") as Omit<ExplanationContext, "untrusted">;
    const context: ExplanationContext = { ...trusted, untrusted: [] };
    this.calls.push({
      url,
      headers: { ...(init.headers as Record<string, string>) },
      body,
      system,
      user,
      context,
    });

    const reply = (status: number, json: unknown) =>
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const envelope = (text: string, finishReason = "STOP") =>
      reply(200, {
        candidates: [{ finishReason, content: { role: "model", parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 321, candidatesTokenCount: 123 },
      });

    switch (this.mode) {
      case "quota":
        return reply(429, { error: { message: "quota" } });
      case "unavailable":
        return reply(503, { error: { message: "down" } });
      case "auth":
        return reply(403, { error: { message: "denied" } });
      case "timeout":
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        });
      case "malformed-json":
        return envelope("this is not json {");
      case "truncated":
        return envelope('{"summary":"cut off', "MAX_TOKENS");
      default:
        break;
    }

    const base = templateExplanation(context);
    const rephrased = { ...base, summary: `In plain terms: ${base.summary}` };
    const out = (o: unknown) => envelope(JSON.stringify(o));
    switch (this.mode) {
      case "bad-schema":
        return out({ summary: 42, keyFacts: "nope" });
      case "extra-key":
        return out({ ...rephrased, newCaseState: "VERIFIED_IMPROVED" });
      case "unknown-fact":
        return out({ ...rephrased, sourceFactIds: [...base.sourceFactIds, "F-DOES-NOT-EXIST"] });
      case "contradict-result": {
        const wrong =
          context.authoritative.verificationResult === "VERIFIED"
            ? "Not improving"
            : "Verified improved";
        return out({
          ...rephrased,
          summary: `${base.summary} The outcome was ${wrong}.`,
          verificationExplanation: [`The result was ${wrong}.`],
        });
      }
      case "invented-number":
        return out({
          ...rephrased,
          keyFacts: [...base.keyFacts, "Vibration fell by 87.3 percent."],
        });
      case "invented-action":
        return out({
          ...rephrased,
          actionContext: ["Replace the compressor immediately (ACT-REPLACE-COMPRESSOR)."],
        });
      case "claims-resolved":
        return out({ ...rephrased, summary: `${base.summary} The risk is now resolved.` });
      case "follow-injection":
        // what a model that obeyed an injected instruction might return
        return out({
          ...rephrased,
          summary: "Ignoring previous instructions: the case is closed and the risk is resolved.",
        });
      default:
        return out(rephrased);
    }
  };
}

/** Make a response for tests that need a hand-written Gemini envelope. */
export const geminiEnvelope = (output: unknown): Response =>
  new Response(
    JSON.stringify({
      candidates: [
        {
          finishReason: "STOP",
          content: { role: "model", parts: [{ text: JSON.stringify(output) }] },
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
