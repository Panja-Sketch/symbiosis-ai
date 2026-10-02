import type { AlertKind } from "@symbiosis/contracts";
import { ALERT_KINDS } from "@symbiosis/contracts";
import type { TenantDocumentStore } from "@symbiosis/repositories";

/**
 * Notification contact data (S10, D-090). Alerts name an ACTOR (D-031); where that actor can be
 * reached is separate, organization-scoped data that only the email channel reads. No address is
 * ever hard-coded in notification code, and none is stored in an alert, an audit entry or a log:
 * only a masked hint is.
 */
export type ContactRecord = {
  readonly actorId: string;
  readonly organizationId: string;
  /** Absent until an organization administrator sets it. */
  readonly email?: string;
  /** The person's own switch for non-essential email. */
  readonly enabled: boolean;
  /** Alert kinds the person wants by email. INITIAL is always delivered while `enabled`. */
  readonly categories: readonly AlertKind[];
  readonly updatedAt: string;
  readonly updatedBy: string;
};

export const DEFAULT_CATEGORIES: readonly AlertKind[] = ALERT_KINDS;

/**
 * Deliberately strict: one plain mailbox, no display name, no list, no comment, no control
 * character. A value that could add a header or a recipient is not an address.
 */
const EMAIL =
  /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function isValidEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && EMAIL.test(value);
}

/** `charan@gmail.com` -> `c***n@gmail.com`. Safe for the UI and the delivery record. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const head = local.slice(0, 1);
  const tail = local.length > 2 ? local.slice(-1) : "";
  return `${head}***${tail}${email.slice(at)}`;
}

export interface ContactDirectory {
  get(organizationId: string, actorId: string): Promise<ContactRecord | undefined>;
  /** Replaces the record. The caller authorizes (who may change an address is a service rule). */
  put(record: ContactRecord): Promise<void>;
  list(organizationId: string): Promise<readonly ContactRecord[]>;
}

export class StoreContactDirectory implements ContactDirectory {
  constructor(private readonly store: TenantDocumentStore) {}

  get(organizationId: string, actorId: string) {
    return this.store.get<ContactRecord>("contacts", organizationId, actorId);
  }

  async put(record: ContactRecord) {
    if (record.email !== undefined && !isValidEmail(record.email)) {
      throw new Error("invalid email address");
    }
    await this.store.put("contacts", record.organizationId, record.actorId, record, {
      actorId: record.actorId,
    });
  }

  list(organizationId: string) {
    return this.store.list<ContactRecord>("contacts", organizationId);
  }
}
