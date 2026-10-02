export const PACKAGE_NAME = "@symbiosis/tenancy" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export const ROLES = [
  "ORG_ADMIN",
  "FACILITY_MANAGER",
  "OPERATOR",
  "RISK_ENGINEER",
  "UNDERWRITER",
  "BROKER_RISK_MANAGER",
  "READ_ONLY_AUDITOR",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * Who is acting, and inside which tenant. The organization and facilities come from the
 * server-side directory, never from request input, so a caller cannot widen their own scope.
 * `facilityIds` of "ALL" means every facility of the organization.
 */
export type ActorContext = {
  readonly actorId: string;
  readonly organizationId: string;
  readonly facilityIds: readonly string[] | "ALL";
  readonly roles: readonly Role[];
};

export function canAccessFacility(actor: ActorContext, facilityId: string): boolean {
  return actor.facilityIds === "ALL" || actor.facilityIds.includes(facilityId);
}

/**
 * Actor/membership lookup. Local mode uses the synthetic in-memory directory below; Firebase
 * Auth + organization membership (S9) will implement the same interface.
 */
export interface ActorDirectory {
  get(actorId: string): Promise<ActorContext | undefined>;
  /** First actor holding `role` for the facility within the organization, if any. */
  findByRole(
    organizationId: string,
    facilityId: string,
    role: Role,
  ): Promise<ActorContext | undefined>;
}

/** What an identity resolver may look at: request headers (lower-case names) and the query. */
export type IdentityRequest = {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly query?: URLSearchParams;
};

/**
 * Turns a request into the canonical actor, or `undefined` (unauthenticated). The result must be
 * derived only from verified credentials plus trusted server-side records: organization, facility
 * scope and roles are never taken from the request. Local mode uses `DemoHeaderIdentityResolver`;
 * production uses a verified-token resolver (S9). `kind` lets callers tell them apart (the HTML proof
 * pages and the dev identity listing exist only for the demo resolver).
 */
export interface IdentityResolver {
  readonly kind: "demo" | "token";
  resolve(request: IdentityRequest): Promise<ActorContext | undefined>;
}

const DEMO_ACTOR_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * LOCAL DEVELOPMENT ONLY: trusts the `X-Demo-Actor-Id` header (or `?actor=`) as an actor id and
 * looks it up in the server-side directory. This is not authentication. Production runtimes must
 * never construct it (the gcp runtime refuses to start with it).
 */
export class DemoHeaderIdentityResolver implements IdentityResolver {
  readonly kind = "demo" as const;

  constructor(private readonly directory: ActorDirectory) {}

  async resolve(request: IdentityRequest): Promise<ActorContext | undefined> {
    const id = request.headers["x-demo-actor-id"] ?? request.query?.get("actor") ?? undefined;
    return id === undefined || !DEMO_ACTOR_ID.test(id) ? undefined : this.directory.get(id);
  }
}

export class InMemoryActorDirectory implements ActorDirectory {
  private readonly actors = new Map<string, ActorContext>();

  constructor(actors: readonly ActorContext[] = []) {
    for (const a of actors) this.actors.set(a.actorId, a);
  }

  async get(actorId: string): Promise<ActorContext | undefined> {
    return this.actors.get(actorId);
  }

  async findByRole(organizationId: string, facilityId: string, role: Role) {
    return [...this.actors.values()].find(
      (a) =>
        a.organizationId === organizationId &&
        a.roles.includes(role) &&
        canAccessFacility(a, facilityId),
    );
  }
}

/**
 * SYNTHETIC LOCAL ACTORS ONLY. These IDs map to no real person, mailbox or credential.
 * Production identity is Firebase Authentication / Identity Platform (S9).
 */
export const SYNTHETIC_ACTORS: readonly ActorContext[] = [
  {
    actorId: "USR-FACILITY-MGR-001",
    organizationId: "ORG-SIM-001",
    facilityIds: ["FAC-SIM-001", "FAC-SIM-PHX-01"],
    roles: ["FACILITY_MANAGER"],
  },
  {
    actorId: "USR-OPERATOR-001",
    organizationId: "ORG-SIM-001",
    facilityIds: ["FAC-SIM-001", "FAC-SIM-PHX-01"],
    roles: ["OPERATOR"],
  },
  {
    actorId: "USR-ORG-ADMIN-001",
    organizationId: "ORG-SIM-001",
    facilityIds: "ALL",
    roles: ["ORG_ADMIN"],
  },
  {
    actorId: "USR-AUDITOR-001",
    organizationId: "ORG-SIM-001",
    facilityIds: "ALL",
    roles: ["READ_ONLY_AUDITOR"],
  },
  {
    actorId: "USR-OTHER-ORG-MGR-001",
    organizationId: "ORG-SIM-002",
    facilityIds: ["FAC-OTHER-001"],
    roles: ["FACILITY_MANAGER"],
  },
  // Insurer-side actors (S6). Their own organization owns no facilities: what they may read is
  // decided by sharing agreements, never by facility membership.
  {
    actorId: "USR-RISK-ENGINEER-001",
    organizationId: "ORG-INS-001",
    facilityIds: "ALL",
    roles: ["RISK_ENGINEER"],
  },
  {
    actorId: "USR-UNDERWRITER-001",
    organizationId: "ORG-INS-001",
    facilityIds: "ALL",
    roles: ["UNDERWRITER"],
  },
  {
    actorId: "USR-OTHER-INSURER-RE-001",
    organizationId: "ORG-INS-002",
    facilityIds: "ALL",
    roles: ["RISK_ENGINEER"],
  },
];

export const ORGANIZATION_TYPES = ["INSURED", "INSURER", "BROKER"] as const;
export type OrganizationType = (typeof ORGANIZATION_TYPES)[number];

/**
 * An organization and the facilities that belong to it. Membership is server-side data: a
 * request can never claim a facility or organization it does not own (spec 36).
 */
export type OrganizationRecord = {
  readonly organizationId: string;
  readonly name: string;
  readonly type: OrganizationType;
  readonly facilityIds: readonly string[];
};

export interface OrganizationDirectory {
  get(organizationId: string): Promise<OrganizationRecord | undefined>;
}

export class InMemoryOrganizationDirectory implements OrganizationDirectory {
  private readonly orgs = new Map<string, OrganizationRecord>();

  constructor(orgs: readonly OrganizationRecord[] = []) {
    for (const o of orgs) this.orgs.set(o.organizationId, o);
  }

  async get(organizationId: string): Promise<OrganizationRecord | undefined> {
    return this.orgs.get(organizationId);
  }
}

/** SYNTHETIC LOCAL ORGANIZATIONS ONLY (S6). Real membership is Firebase-backed in S9. */
export const SYNTHETIC_ORGANIZATIONS: readonly OrganizationRecord[] = [
  {
    organizationId: "ORG-SIM-001",
    name: "Synthetic Cold Storage Co (insured)",
    type: "INSURED",
    facilityIds: ["FAC-SIM-001", "FAC-SIM-PHX-01"],
  },
  {
    organizationId: "ORG-SIM-002",
    name: "Synthetic Other Insured Co",
    type: "INSURED",
    facilityIds: ["FAC-OTHER-001"],
  },
  {
    organizationId: "ORG-INS-001",
    name: "Synthetic Insurer One",
    type: "INSURER",
    facilityIds: [],
  },
  {
    organizationId: "ORG-INS-002",
    name: "Synthetic Insurer Two",
    type: "INSURER",
    facilityIds: [],
  },
];

export function createSyntheticOrganizationDirectory(): InMemoryOrganizationDirectory {
  return new InMemoryOrganizationDirectory(SYNTHETIC_ORGANIZATIONS);
}

export function createSyntheticActorDirectory(): InMemoryActorDirectory {
  return new InMemoryActorDirectory(SYNTHETIC_ACTORS);
}
