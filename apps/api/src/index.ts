import { SCAFFOLD_PHASE as CONTRACTS_SCAFFOLD_PHASE } from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/api" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Runtime use of the workspace dependency; proves resolution (S0 smoke test). */
export const RESOLVED_CONTRACTS_PHASE = CONTRACTS_SCAFFOLD_PHASE;

export * from "./edge-handler";
export * from "./app-handler";
export * from "./html";
export * from "./server";
