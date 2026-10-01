import type { ActorContext, Role } from "@symbiosis/tenancy";

export const PACKAGE_NAME = "@symbiosis/authz" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export const PERMISSIONS = [
  "CASE_READ",
  "CASE_ACKNOWLEDGE",
  "ACTION_ASSIGN",
  "ACTION_ACKNOWLEDGE",
  "ACTION_REPORT",
  "RISK_DISMISS",
  "OPS_TICK",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Local application-level authorization (role -> permission). It is enforced by the
 * application services, but it is NOT production authorization: roles come from the synthetic
 * local directory, and real enforcement with Firebase identity arrives in S9/S11.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ORG_ADMIN: [...PERMISSIONS],
  FACILITY_MANAGER: [
    "CASE_READ",
    "CASE_ACKNOWLEDGE",
    "ACTION_ASSIGN",
    "ACTION_ACKNOWLEDGE",
    "ACTION_REPORT",
    "RISK_DISMISS",
  ],
  OPERATOR: ["CASE_READ", "CASE_ACKNOWLEDGE", "ACTION_ACKNOWLEDGE", "ACTION_REPORT"],
  READ_ONLY_AUDITOR: ["CASE_READ"],
  // Insurer-side roles never act on the operations workflow (spec 2.2/2.3).
  RISK_ENGINEER: [],
  UNDERWRITER: [],
  BROKER_RISK_MANAGER: [],
};

export function permissionsFor(roles: readonly Role[]): readonly Permission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]))];
}

export function can(actor: ActorContext, permission: Permission): boolean {
  return actor.roles.some((r) => ROLE_PERMISSIONS[r].includes(permission));
}
