import { buildPrompt } from "./prompt";
import { ProviderError } from "./types";
import type { ExplanationProvider, ProviderRequest, ProviderResponse } from "./types";

/**
 * The Gemini adapter, over the Vertex AI `generateContent` REST endpoint (spec 12.1: Vertex AI,
 * explanation only). It is the only code that knows about Gemini. It has no SDK dependency, takes
 * its network function and credential supplier as inputs (so tests never touch the network), puts
 * the credential only in the Authorization header, and never puts a prompt, a response body or a
 * credential in an error message. It returns raw, unvalidated output: the service validates it.
 */

export type GeminiConfig = {
  readonly projectId: string;
  readonly location: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
};

export type AccessTokenProvider = () => Promise<string>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const STRING_ARRAY = { type: "ARRAY", items: { type: "STRING" } } as const;
/** The structured-output schema sent to Gemini (Vertex responseSchema). The validator stays authoritative. */
export const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    keyFacts: STRING_ARRAY,
    whyItMatters: STRING_ARRAY,
    actionContext: STRING_ARRAY,
    verificationExplanation: STRING_ARRAY,
    interventionExplanation: STRING_ARRAY,
    evidenceExplanation: STRING_ARRAY,
    limitations: STRING_ARRAY,
    sourceFactIds: STRING_ARRAY,
  },
  required: [
    "summary",
    "keyFacts",
    "whyItMatters",
    "actionContext",
    "verificationExplanation",
    "interventionExplanation",
    "evidenceExplanation",
    "limitations",
    "sourceFactIds",
  ],
} as const;

export const geminiUrl = (c: Pick<GeminiConfig, "projectId" | "location" | "model">): string =>
  `https://${c.location === "global" ? "" : `${c.location}-`}aiplatform.googleapis.com/v1/projects/${encodeURIComponent(c.projectId)}/locations/${encodeURIComponent(c.location)}/publishers/google/models/${encodeURIComponent(c.model)}:generateContent`;

export class GeminiExplanationProvider implements ExplanationProvider {
  readonly name = "gemini";
  readonly model: string;

  constructor(
    private readonly config: GeminiConfig,
    private readonly token: AccessTokenProvider,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.model = config.model;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const c = this.config;
    if (c.projectId === "" || c.location === "" || c.model === "") {
      throw new ProviderError(
        "NOT_CONFIGURED",
        "Gemini project, location or model is not configured",
      );
    }
    let accessToken: string;
    try {
      accessToken = await this.token();
    } catch {
      throw new ProviderError("AUTH", "no access token could be obtained");
    }
    if (accessToken === "") throw new ProviderError("AUTH", "no access token could be obtained");

    const prompt = buildPrompt(request.context, request.promptVersion);
    const body = {
      systemInstruction: { role: "system", parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: {
        temperature: c.temperature,
        maxOutputTokens: c.maxOutputTokens,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    };

    let res: Response;
    try {
      res = await this.fetchImpl(geminiUrl(c), {
        method: "POST",
        signal: request.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (request.signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        throw new ProviderError("TIMEOUT", "the Gemini request timed out");
      }
      throw new ProviderError("UNAVAILABLE", "the Gemini endpoint could not be reached");
    }
    if (res.status === 429) throw new ProviderError("QUOTA", "Gemini quota or rate limit reached");
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError("AUTH", "Gemini rejected the credential");
    }
    if (res.status >= 500)
      throw new ProviderError("UNAVAILABLE", `Gemini is unavailable (${res.status})`);
    if (!res.ok) throw new ProviderError("ERROR", `Gemini answered ${res.status}`);

    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new ProviderError("MALFORMED", "the Gemini response was not JSON");
    }
    const p = payload as {
      candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const cand = p.candidates?.[0];
    if (cand === undefined || (cand.finishReason !== undefined && cand.finishReason !== "STOP")) {
      throw new ProviderError("MALFORMED", "the Gemini response had no complete candidate");
    }
    const text = (cand.content?.parts ?? []).map((x) => x.text ?? "").join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("MALFORMED", "the Gemini output was not valid JSON");
    }
    return {
      output,
      usage: {
        ...(p.usageMetadata?.promptTokenCount !== undefined && {
          inputTokens: p.usageMetadata.promptTokenCount,
        }),
        ...(p.usageMetadata?.candidatesTokenCount !== undefined && {
          outputTokens: p.usageMetadata.candidatesTokenCount,
        }),
      },
    };
  }
}
