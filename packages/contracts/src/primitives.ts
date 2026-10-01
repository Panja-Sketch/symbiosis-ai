/** Nominal typing helper for opaque string identifiers. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** ISO-8601 timestamp string. */
export type IsoTimestamp = string;

export type OrganizationId = Brand<string, "OrganizationId">;
export type FacilityId = Brand<string, "FacilityId">;
export type AssetId = Brand<string, "AssetId">;
export type DeviceId = Brand<string, "DeviceId">;

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  return typeof value === "string" && ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

/** True when `a` is strictly earlier than `b`. Both must be valid ISO timestamps. */
export function isEarlier(a: IsoTimestamp, b: IsoTimestamp): boolean {
  return Date.parse(a) < Date.parse(b);
}

export type TimeWindow = {
  readonly start: IsoTimestamp;
  readonly end: IsoTimestamp;
};
