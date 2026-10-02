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
  /**
   * Entries of the organization with a sequence greater than `afterSequence`, oldest first (S10: the
   * simulation timeline reads incrementally instead of re-reading the whole log).
   */
  listAfter(
    organizationId: string,
    afterSequence: number,
    limit?: number,
  ): Promise<readonly AuditEntry[]>;
  /** The organization's latest sequence number (0 when the log is empty). */
  lastSequence(organizationId: string): Promise<number>;
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

  async listAfter(organizationId: string, afterSequence: number, limit = 1000) {
    return this.entries
      .filter((e) => e.organizationId === organizationId && e.sequence > afterSequence)
      .slice(0, limit);
  }

  async lastSequence(organizationId: string): Promise<number> {
    return this.entries.reduce(
      (max, e) => (e.organizationId === organizationId ? Math.max(max, e.sequence) : max),
      0,
    );
  }
}
