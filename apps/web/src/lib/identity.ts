import type { DirectoryDto, IdentityDto, MeDto, OrganizationDto } from "./types";

/**
 * Development identity helpers (S7 local/demo mode). The identity is only a cookie holding an
 * actor id; the API looks that id up in its server-side directory and takes organization,
 * facilities and roles from there. Nothing here is authentication, and production identity
 * (Firebase) replaces it in S9.
 */
export const IDENTITY_COOKIE = "symbiosis_demo_actor";

export type Persona = "FACILITY" | "INSURER";

/** Navigation grouping only: what the actor may DO is decided by the API on every call. */
export const personaOf = (identity: Pick<IdentityDto, "permissions">): Persona =>
  identity.permissions.includes("INSURANCE_EVIDENCE_READ") ? "INSURER" : "FACILITY";

export const homeFor = (persona: Persona): string =>
  persona === "INSURER" ? "/risk-evidence" : "/operations";

export const PERSONA_LABELS: Readonly<Record<Persona, string>> = {
  FACILITY: "Facility / property manager",
  INSURER: "Underwriter / risk engineer",
};

const ROLE_LABELS: Readonly<Record<string, string>> = {
  ORG_ADMIN: "Organization Admin",
  FACILITY_MANAGER: "Facility Manager",
  OPERATOR: "Operator",
  READ_ONLY_AUDITOR: "Auditor",
  RISK_ENGINEER: "Risk Engineer",
  UNDERWRITER: "Underwriter",
  BROKER_RISK_MANAGER: "Broker Risk Manager",
};
export const roleLabel = (role: string): string => ROLE_LABELS[role] ?? role;

export type Session = {
  readonly actorId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly facilityIds: readonly string[] | "ALL";
  readonly roles: readonly string[];
  readonly permissions: readonly string[];
  readonly persona: Persona;
  readonly roleLabel: string;
};

export function buildSession(me: MeDto, orgs: readonly OrganizationDto[]): Session {
  return {
    actorId: me.actorId,
    organizationId: me.organizationId,
    organizationName:
      orgs.find((o) => o.organizationId === me.organizationId)?.name ?? me.organizationId,
    facilityIds: me.facilityIds,
    roles: me.roles,
    permissions: me.permissions,
    persona: personaOf(me),
    roleLabel: me.roles.map(roleLabel).join(", "),
  };
}

/** actor id -> readable name ("Operator · USR-OPERATOR-001"), used wherever a person is shown. */
export type People = Readonly<Record<string, string>>;

export function peopleFrom(dir: DirectoryDto | undefined): People {
  const out: Record<string, string> = {};
  for (const a of dir?.actors ?? []) {
    out[a.actorId] = `${a.roles.map(roleLabel).join(", ")} · ${a.actorId}`;
  }
  return out;
}
export const personLabel = (people: People, id: string | undefined): string =>
  id === undefined ? "—" : (people[id] ?? id);

export type OrgNames = Readonly<Record<string, string>>;
export const orgNamesFrom = (dir: DirectoryDto | undefined): OrgNames =>
  Object.fromEntries((dir?.organizations ?? []).map((o) => [o.organizationId, o.name]));
export const orgLabel = (names: OrgNames, id: string): string => names[id] ?? id;

/** Same-site path guard for `returnTo` values coming from a form. */
export const safeLocalPath = (p: unknown): string | undefined =>
  typeof p === "string" && /^\/(?!\/)[A-Za-z0-9/_\-.?=&%#]*$/.test(p) ? p : undefined;

/**
 * Where a person lands after switching identity: back where they were if that area belongs to
 * their persona (so a manager and an operator can take turns on one case), otherwise home.
 */
export function landingFor(persona: Persona, returnTo: string | undefined): string {
  const area = persona === "INSURER" ? "/risk-evidence" : "/operations";
  if (returnTo !== undefined && (returnTo === area || returnTo.startsWith(`${area}/`))) {
    return returnTo.split(/[?#]/)[0] ?? area;
  }
  if (returnTo === "/trust") return "/trust";
  return homeFor(persona);
}
