import type { AuditEntry } from "@symbiosis/contracts";

export const PACKAGE_NAME = "@symbiosis/audit" as const;
export const SCAFFOLD_PHASE = "S0" as const;

export type NewAuditEntry = Omit<AuditEntry, "auditId" | "sequence">;

/**
 * Append-only operational audit log. There is deliberately no update or delete. S4 records
 * material workflow actions; hash chaining and tamper evidence are later hardening (spec 37).
 * Reads are organization-scoped.
 */
export interface AuditLog {
  append(entry: NewAuditEntry): Promise<AuditEntry>;
  listByCase(organizationId: string, caseId: string): Promise<readonly AuditEntry[]>;
  list(organizationId: string): Promise<readonly AuditEntry[]>;
}

export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  async append(entry: NewAuditEntry): Promise<AuditEntry> {
    const sequence = this.entries.length + 1;
    const stored: AuditEntry = Object.freeze({
      ...entry,
      auditId: `AUD-${String(sequence).padStart(6, "0")}`,
      sequence,
    });
    this.entries.push(stored);
    return stored;
  }

  async listByCase(organizationId: string, caseId: string): Promise<readonly AuditEntry[]> {
    return this.entries.filter((e) => e.organizationId === organizationId && e.caseId === caseId);
  }

  async list(organizationId: string): Promise<readonly AuditEntry[]> {
    return this.entries.filter((e) => e.organizationId === organizationId);
  }
}
