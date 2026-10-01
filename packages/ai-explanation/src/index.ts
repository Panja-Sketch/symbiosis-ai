export const PACKAGE_NAME = "@symbiosis/ai-explanation" as const;
export const SCAFFOLD_PHASE = "S8" as const;

export * from "./types";
export * from "./facts";
export * from "./template";
export * from "./validate";
export * from "./prompt";
export * from "./gemini";
export * from "./fake-gemini";
export * from "./service";
export * from "./config";
export { RESULT_LABELS, INTERVENTION_LABELS } from "./phrases";
