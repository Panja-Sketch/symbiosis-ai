import { describe, expect, it } from "vitest";
import type {
  EvidencePackageRecord,
  SharedEvidenceRecord,
  SharingAgreement,
} from "@symbiosis/contracts";
import {
  InMemoryEvidencePackageRepository,
  InMemorySharedEvidenceRepository,
  InMemorySharingAgreementRepository,
} from "./index";

const rec = (patch: Partial<EvidencePackageRecord> = {}): EvidencePackageRecord => ({
  packageId: "EVP-1",
  organizationId: "ORG-A",
  facilityId: "FAC-1",
  caseId: "CASE-1",
  verificationId: "VER-1",
  result: "VERIFIED",
  createdAt: "2026-10-01T00:00:00.000Z",
  verificationEvaluatedAt: "2026-10-01T00:00:00.000Z",
  schemaVersion: "evidence-package.v1",
  payloadSha256: "a".repeat(64),
  manifestSha256: "b".repeat(64),
  objectKey: "evidence/ORG-A/EVP-1.json",
  byteLength: 10,
  ...patch,
});

describe("InMemoryEvidencePackageRepository", () => {
  it("inserts once per package id and once per verification", async () => {
    const r = new InMemoryEvidencePackageRepository();
    expect(await r.insertIfAbsent(rec())).toBe(true);
    expect(await r.insertIfAbsent(rec())).toBe(false);
    expect(await r.insertIfAbsent(rec({ packageId: "EVP-2" }))).toBe(false); // same verification
    expect(await r.insertIfAbsent(rec({ packageId: "EVP-3", verificationId: "VER-2" }))).toBe(true);
    expect((await r.listByCase("ORG-A", "CASE-1")).map((x) => x.packageId)).toEqual([
      "EVP-1",
      "EVP-3",
    ]);
  });

  it("is organization-scoped on every read", async () => {
    const r = new InMemoryEvidencePackageRepository();
    await r.insertIfAbsent(rec());
    expect(await r.get("ORG-B", "EVP-1")).toBeUndefined();
    expect(await r.getByVerification("ORG-B", "VER-1")).toBeUndefined();
    expect(await r.listByCase("ORG-B", "CASE-1")).toEqual([]);
    expect((await r.get("ORG-A", "EVP-1"))?.verificationId).toBe("VER-1");
  });

  it("stored records cannot be mutated by callers", async () => {
    const r = new InMemoryEvidencePackageRepository();
    await r.insertIfAbsent(rec());
    const got = (await r.get("ORG-A", "EVP-1")) as { result: string };
    expect(() => {
      got.result = "NOT_IMPROVING";
    }).toThrow();
  });

  it("lists history oldest first", async () => {
    const r = new InMemoryEvidencePackageRepository();
    await r.insertIfAbsent(
      rec({ packageId: "EVP-2", verificationId: "VER-2", createdAt: "2026-10-01T02:00:00.000Z" }),
    );
    await r.insertIfAbsent(rec());
    expect((await r.listByCase("ORG-A", "CASE-1")).map((x) => x.packageId)).toEqual([
      "EVP-1",
      "EVP-2",
    ]);
  });
});

const agreement = (patch: Partial<SharingAgreement> = {}): SharingAgreement => ({
  agreementId: "AGR-1",
  organizationId: "ORG-A",
  recipientOrganizationId: "ORG-I",
  scopes: ["RECOMMENDATION"],
  facilityIds: ["FAC-1"],
  effectiveFrom: "2026-10-01T00:00:00.000Z",
  createdBy: "USR-1",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...patch,
});

describe("InMemorySharingAgreementRepository", () => {
  it("refuses a duplicate id and scopes owner and recipient reads", async () => {
    const r = new InMemorySharingAgreementRepository();
    await r.insert(agreement());
    await expect(r.insert(agreement())).rejects.toThrow(/already exists/);
    expect(await r.getForOwner("ORG-B", "AGR-1")).toBeUndefined();
    expect(await r.listForOwner("ORG-B")).toEqual([]);
    expect(await r.listForRecipient("ORG-X")).toEqual([]);
    expect((await r.listForRecipient("ORG-I")).map((a) => a.agreementId)).toEqual(["AGR-1"]);
    expect(await r.listForOwner("ORG-A")).toHaveLength(1);
  });

  it("revocation sets metadata once, keeps the terms, and cannot be repeated or undone", async () => {
    const r = new InMemorySharingAgreementRepository();
    await r.insert(agreement());
    const first = await r.revoke("ORG-A", "AGR-1", {
      revokedAt: "2026-10-02T00:00:00.000Z",
      revokedBy: "USR-2",
      reason: "why",
    });
    expect(first.status).toBe("REVOKED");
    expect(first.status === "REVOKED" && first.agreement).toMatchObject({
      agreementId: "AGR-1",
      scopes: ["RECOMMENDATION"],
      facilityIds: ["FAC-1"],
      createdBy: "USR-1",
      revokedAt: "2026-10-02T00:00:00.000Z",
      revokedBy: "USR-2",
      revocationReason: "why",
    });
    const second = await r.revoke("ORG-A", "AGR-1", {
      revokedAt: "2030-01-01T00:00:00.000Z",
      revokedBy: "USR-3",
    });
    expect(second.status).toBe("ALREADY_REVOKED");
    expect((await r.getForOwner("ORG-A", "AGR-1"))?.revokedAt).toBe("2026-10-02T00:00:00.000Z");
    expect((await r.revoke("ORG-B", "AGR-1", { revokedAt: "x", revokedBy: "y" })).status).toBe(
      "NOT_FOUND",
    );
    expect((await r.revoke("ORG-A", "AGR-9", { revokedAt: "x", revokedBy: "y" })).status).toBe(
      "NOT_FOUND",
    );
    expect(await r.listAllForSystemTick()).toHaveLength(1);
  });

  it("stored agreements are frozen", async () => {
    const r = new InMemorySharingAgreementRepository();
    await r.insert(agreement());
    const a = (await r.getForOwner("ORG-A", "AGR-1")) as { createdBy: string };
    expect(() => {
      a.createdBy = "USR-EVIL";
    }).toThrow();
  });
});

describe("InMemorySharedEvidenceRepository", () => {
  const share = (patch: Partial<SharedEvidenceRecord> = {}): SharedEvidenceRecord => ({
    shareId: "SHR-1",
    agreementId: "AGR-1",
    organizationId: "ORG-A",
    facilityId: "FAC-1",
    caseId: "CASE-1",
    evidencePackageId: "EVP-1",
    recipientOrganizationId: "ORG-I",
    sharedAt: "2026-10-01T00:00:00.000Z",
    ...patch,
  });

  it("records one release per agreement and package", async () => {
    const r = new InMemorySharedEvidenceRepository();
    expect(await r.insertIfAbsent(share())).toBe(true);
    expect(await r.insertIfAbsent(share({ shareId: "SHR-2" }))).toBe(false);
    expect(await r.insertIfAbsent(share({ shareId: "SHR-3", evidencePackageId: "EVP-2" }))).toBe(
      true,
    );
    expect(await r.listByCase("ORG-A", "CASE-1")).toHaveLength(2);
    expect(await r.listByCase("ORG-B", "CASE-1")).toEqual([]);
    expect(await r.listByAgreement("ORG-A", "AGR-1")).toHaveLength(2);
    expect(await r.listByAgreement("ORG-B", "AGR-1")).toEqual([]);
  });
});
