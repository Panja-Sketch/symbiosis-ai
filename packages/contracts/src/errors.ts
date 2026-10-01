export const DOMAIN_ENTITIES = [
  "RECOMMENDATION",
  "CASE",
  "RISK_EVENT",
  "ACTION",
  "VERIFICATION",
  "BASELINE",
] as const;
export type DomainEntity = (typeof DOMAIN_ENTITIES)[number];

export const DOMAIN_ERROR_CODES = [
  "INVALID_INPUT",
  "ILLEGAL_LIFECYCLE_TRANSITION",
  "ILLEGAL_ACTION_TRANSITION",
  "ILLEGAL_RECOMMENDATION_TRANSITION",
  "MISSING_VERIFICATION_REFERENCE",
  "VERIFICATION_MISMATCH",
  "INVALID_RECURRENCE",
  "MISSING_ACTIVE_RISK_EVENT",
  "TIMESTAMP_REGRESSION",
] as const;
export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export type DomainError = {
  readonly code: DomainErrorCode;
  readonly entity: DomainEntity;
  readonly message: string;
  readonly from?: string;
  readonly to?: string;
  readonly issues?: readonly string[];
};

export function domainError(
  code: DomainErrorCode,
  entity: DomainEntity,
  message: string,
  details: { from?: string; to?: string; issues?: readonly string[] } = {},
): DomainError {
  return {
    code,
    entity,
    message,
    ...(details.from !== undefined && { from: details.from }),
    ...(details.to !== undefined && { to: details.to }),
    ...(details.issues !== undefined && { issues: details.issues }),
  };
}
