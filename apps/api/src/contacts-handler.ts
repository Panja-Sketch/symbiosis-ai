import { ALERT_KINDS } from "@symbiosis/contracts";
import type { AlertKind } from "@symbiosis/contracts";
import { can } from "@symbiosis/authz";
import type { AuditLog } from "@symbiosis/audit";
import type { Clock } from "@symbiosis/clock";
import type { IdGenerator } from "@symbiosis/event-bus";
import { isValidEmail, maskEmail } from "@symbiosis/notifications";
import type { ContactDirectory, ContactRecord } from "@symbiosis/notifications";
import type { ActorContext, ActorDirectory } from "@symbiosis/tenancy";
import type { EdgeResponse } from "./edge-handler";

/**
 * Where people can be reached (S10, D-090). A person may switch their own email on or off and choose
 * which kinds they want; they cannot change the ADDRESS. An address is a deliverable destination for
 * alert text, so only an organization administrator may set it, only for actors of the same
 * organization, and the address is never returned in full (a masked hint only).
 */
export type ContactsApiDeps = {
  readonly contacts: ContactDirectory;
  readonly directory: ActorDirectory;
  readonly audit: AuditLog;
  readonly ids: IdGenerator;
  readonly clock: Clock;
};

const json = (status: number, body: unknown): EdgeResponse => ({ status, body });
const problem = (status: number, code: string, message: string): EdgeResponse =>
  json(status, { error: { code, message } });
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const dto = (c: ContactRecord | undefined, actorId: string) => ({
  actorId,
  email: c?.email === undefined ? null : maskEmail(c.email),
  hasAddress: c?.email !== undefined,
  enabled: c?.enabled ?? true,
  categories: c?.categories ?? [...ALERT_KINDS],
  updatedAt: c?.updatedAt ?? null,
});

export function createContactsApi(deps: ContactsApiDeps) {
  const now = () => new Date(deps.clock.nowMs()).toISOString();

  return async (input: {
    readonly actor: ActorContext;
    readonly method: string;
    /** The path after `/api/v1`. */
    readonly route: readonly string[];
    readonly body: Record<string, unknown>;
  }): Promise<EdgeResponse | undefined> => {
    const { actor, method, route, body } = input;
    const org = actor.organizationId;

    if (route[0] === "me" && route[1] === "notification-preferences" && route.length === 2) {
      if (!can(actor, "NOTIFICATION_PREFERENCES_SELF")) {
        return problem(403, "FORBIDDEN", "Missing permission NOTIFICATION_PREFERENCES_SELF");
      }
      const current = await deps.contacts.get(org, actor.actorId);
      if (method === "GET") return json(200, dto(current, actor.actorId));
      if (method !== "PUT") return problem(405, "METHOD_NOT_ALLOWED", "GET or PUT");
      for (const k of Object.keys(body)) {
        if (k !== "enabled" && k !== "categories") {
          return problem(
            400,
            "INVALID_REQUEST",
            `"${k}" cannot be changed here (an address is set by an administrator)`,
          );
        }
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return problem(400, "INVALID_REQUEST", "enabled must be true or false");
      }
      let categories: readonly AlertKind[] | undefined;
      if (body.categories !== undefined) {
        const c = body.categories;
        if (!Array.isArray(c) || !c.every((x) => (ALERT_KINDS as readonly unknown[]).includes(x))) {
          return problem(
            400,
            "INVALID_REQUEST",
            `categories must be a list of ${ALERT_KINDS.join(", ")}`,
          );
        }
        categories = [...new Set(c as AlertKind[])];
      }
      const next: ContactRecord = {
        actorId: actor.actorId,
        organizationId: org,
        ...(current?.email !== undefined && { email: current.email }),
        enabled: (body.enabled as boolean | undefined) ?? current?.enabled ?? true,
        categories: categories ?? current?.categories ?? [...ALERT_KINDS],
        updatedAt: now(),
        updatedBy: actor.actorId,
      };
      await deps.contacts.put(next);
      return json(200, dto(next, actor.actorId));
    }

    if (route[0] === "contacts") {
      if (!can(actor, "CONTACT_MANAGE"))
        return problem(403, "FORBIDDEN", "Missing permission CONTACT_MANAGE");
      if (route.length === 1 && method === "GET") {
        const all = await deps.contacts.list(org);
        return json(200, { contacts: all.map((c) => dto(c, c.actorId)) });
      }
      if (route.length === 2 && method === "PUT" && ID.test(route[1] ?? "")) {
        const target = route[1] as string;
        const who = await deps.directory.get(target);
        // Another organization's actor is "not found", exactly like an unknown one.
        if (who === undefined || who.organizationId !== org)
          return problem(404, "NOT_FOUND", "Unknown actor");
        if (!isValidEmail(body.email))
          return problem(400, "INVALID_REQUEST", "email must be a single valid address");
        const current = await deps.contacts.get(org, target);
        const next: ContactRecord = {
          actorId: target,
          organizationId: org,
          email: body.email,
          enabled: current?.enabled ?? true,
          categories: current?.categories ?? [...ALERT_KINDS],
          updatedAt: now(),
          updatedBy: actor.actorId,
        };
        await deps.contacts.put(next);
        await deps.audit.append({
          organizationId: org,
          facilityId: who.facilityIds === "ALL" ? "ALL" : (who.facilityIds[0] ?? "ALL"),
          actorId: actor.actorId,
          actorType: "USER",
          action: "CONTACT_UPDATED",
          targetType: "CONTACT",
          targetId: target,
          correlationId: deps.ids.next("CORR"),
          at: next.updatedAt,
          details: { address: maskEmail(body.email) },
        });
        return json(200, dto(next, target));
      }
      return problem(404, "NOT_FOUND", "Unknown route");
    }
    return undefined;
  };
}

export type ContactsApi = ReturnType<typeof createContactsApi>;
