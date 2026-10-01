export const PACKAGE_NAME = "@symbiosis/contracts" as const;
export const SCAFFOLD_PHASE = "S0" as const;

/** Nominal typing helper for opaque string identifiers. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

export type OrganizationId = Brand<string, "OrganizationId">;
export type FacilityId = Brand<string, "FacilityId">;
export type AssetId = Brand<string, "AssetId">;
export type DeviceId = Brand<string, "DeviceId">;
