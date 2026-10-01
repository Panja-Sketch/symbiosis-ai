import { GeminiExplanationProvider, validateExplanation } from "@symbiosis/ai-explanation";
import { createAdcAccessTokenProvider } from "@symbiosis/adapter-gcp";
import { facilityContext, insurerContext } from "../packages/ai-explanation/src/fixtures";

/**
 * Live Vertex AI check (S9, opt-in, SYNTHETIC facts only): runs the real Gemini adapter with ADC
 * against each `model@location` given on the command line and validates the answer with the S8
 * validator. Usage: tsx scripts/vertex-live.ts gemini-3.1-flash-lite@global gemini-2.5-flash@us-central1
 */
const project = process.env.GCP_PROJECT_ID ?? "";
if (project === "") throw new Error("set GCP_PROJECT_ID");
const token = createAdcAccessTokenProvider();
let bad = 0;
for (const arg of process.argv.slice(2)) {
  const [model = "", location = "us-central1"] = arg.split("@");
  const provider = new GeminiExplanationProvider(
    {
      projectId: project,
      location,
      model,
      temperature: 0.1,
      maxOutputTokens: 1500,
      timeoutMs: 30000,
    },
    token,
  );
  for (const [label, ctx] of [
    ["facility", facilityContext("VERIFIED")],
    ["insurer", insurerContext()],
  ] as const) {
    const t0 = Date.now();
    try {
      const out = await provider.generate({
        context: ctx,
        promptVersion: "explain-prompt.v1",
        schemaVersion: "explanation-output.v1",
        signal: AbortSignal.timeout(30000),
      });
      const v = validateExplanation(out.output, ctx);
      console.log(
        `${model}@${location} ${label}: HTTP ok, ${Date.now() - t0} ms, validator ${v.ok ? "VALID" : `REJECTED ${JSON.stringify(v)}`}`,
      );
      if (!v.ok) bad += 1;
    } catch (e) {
      bad += 1;
      console.log(
        `${model}@${location} ${label}: FAILED ${e instanceof Error ? `${e.name}:${(e as { code?: string }).code ?? ""} ${e.message}` : String(e)}`,
      );
    }
  }
}
process.exitCode = bad === 0 ? 0 : 1;
