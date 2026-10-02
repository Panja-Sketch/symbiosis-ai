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
  "INTERVENTION_READ",
  "INTERVENTION_ACKNOWLEDGE",
  "EVIDENCE_READ",
  "SHARING_MANAGE",
  /** Granting RAW_TELEMETRY is a separate, stronger permission (S6, D-049). */
  "SHARING_GRANT_RAW_TELEMETRY",
  /** Insurer-side read of consent-filtered evidence. Never an operations permission. */
  "INSURANCE_EVIDENCE_READ",
  /** Facility Simulation (S10): operations and admin only, never an insurer permission. */
  "SIMULATION_READ",
  "SIMULATION_CONTROL",
  "SIMULATION_POLICY_EDIT",
  "SIMULATION_ADAPTER_EDIT",
  /** Resets the simulation facility to a clean state (destructive for simulation data only). */
  "SIMULATION_RESET",
  /** Set where an actor can be emailed (an address is a deliverable destination: admin only). */
  "CONTACT_MANAGE",
  /** Own notification preferences (on or off, which kinds). */
  "NOTIFICATION_PREFERENCES_SELF",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Local application-level authorization (role -> permission). It is enforced by the
 * application services, but it is NOT production authorization: roles come from the synthetic
 * local directory, and real enforcement with Firebase identity arrives in S9/S11.
 */
const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  ORG_ADMIN: PERMISSIONS.filter((p) => p !== "INSURANCE_EVIDENCE_READ"),
  FACILITY_MANAGER: [
    "CASE_READ",
    "CASE_ACKNOWLEDGE",
    "ACTION_ASSIGN",
    "ACTION_ACKNOWLEDGE",
    "ACTION_REPORT",
    "RISK_DISMISS",
    "INTERVENTION_READ",
    "INTERVENTION_ACKNOWLEDGE",
    "EVIDENCE_READ",
    "SHARING_MANAGE",
    "SIMULATION_READ",
    "SIMULATION_CONTROL",
    "SIMULATION_POLICY_EDIT",
    "SIMULATION_ADAPTER_EDIT",
    "SIMULATION_RESET",
    "NOTIFICATION_PREFERENCES_SELF",
  ],
  OPERATOR: [
    "CASE_READ",
    "CASE_ACKNOWLEDGE",
    "ACTION_ACKNOWLEDGE",
    "ACTION_REPORT",
    "SIMULATION_READ",
    "SIMULATION_CONTROL",
    "NOTIFICATION_PREFERENCES_SELF",
  ],
  READ_ONLY_AUDITOR: ["CASE_READ", "INTERVENTION_READ", "EVIDENCE_READ", "SIMULATION_READ"],
  // Insurer-side roles never act on the operations workflow (spec 2.2/2.3); they only read the
  // consent-filtered evidence API.
  RISK_ENGINEER: ["INSURANCE_EVIDENCE_READ"],
  UNDERWRITER: ["INSURANCE_EVIDENCE_READ"],
  BROKER_RISK_MANAGER: ["INSURANCE_EVIDENCE_READ"],
};

export function permissionsFor(roles: readonly Role[]): readonly Permission[] {
  return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]))];
}

export function can(actor: ActorContext, permission: Permission): boolean {
  return actor.roles.some((r) => ROLE_PERMISSIONS[r].includes(permission));
}
