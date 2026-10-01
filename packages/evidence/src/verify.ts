import {
  EVIDENCE_CANONICALIZATION,
  EVIDENCE_HASH_ALGORITHM,
  EVIDENCE_MANIFEST_SCHEMA,
  EVIDENCE_PACKAGE_SCHEMA,
} from "@symbiosis/contracts";
import type { EvidenceArtifactDescriptor, EvidencePackage } from "@symbiosis/contracts";
import { canonicalJson } from "./canonical";
import { sha256OfCanonical } from "./hash";

export type EvidenceIntegrity = {
  readonly valid: boolean;
  /** Empty when valid. Stable machine-readable codes. */
  readonly issues: readonly string[];
  readonly payloadSha256: string | null;
  readonly manifestSha256: string | null;
};

const sameDescriptors = (
  a: readonly EvidenceArtifactDescriptor[],
  b: readonly EvidenceArtifactDescriptor[],
) =>
  a.length === b.length &&
  a.every((x, i) => x.id === b[i]?.id && x.kind === b[i]?.kind && x.sha256 === b[i]?.sha256);

/**
 * Recomputes every hash of a package from its own content and checks that the manifest, the
 * payload and the artifacts agree. It reads nothing outside the package, so a package stays
 * verifiable after the live records it was built from have changed. Never throws: anything it
 * cannot hash or parse is reported as an issue and the package is NOT valid.
 */
export function verifyEvidencePackage(pkg: EvidencePackage): EvidenceIntegrity {
  const issues: string[] = [];
  let payloadSha256: string | null = null;
  let manifestSha256: string | null = null;
  try {
    const { manifest, payload } = pkg;
    if (pkg.schemaVersion !== EVIDENCE_PACKAGE_SCHEMA) issues.push("PACKAGE_SCHEMA_UNKNOWN");
    if (manifest.manifestSchema !== EVIDENCE_MANIFEST_SCHEMA)
      issues.push("MANIFEST_SCHEMA_UNKNOWN");
    if (manifest.hashAlgorithm !== EVIDENCE_HASH_ALGORITHM) issues.push("HASH_ALGORITHM_UNKNOWN");
    if (manifest.canonicalization !== EVIDENCE_CANONICALIZATION) {
      issues.push("CANONICALIZATION_UNKNOWN");
    }

    // 1. every artifact's own hash
    const seen = new Set<string>();
    for (const a of pkg.artifacts) {
      const key = `${a.kind}|${a.id}`;
      if (seen.has(key)) issues.push(`ARTIFACT_DUPLICATE:${key}`);
      seen.add(key);
      if (sha256OfCanonical(a.snapshot) !== a.sha256) issues.push(`ARTIFACT_HASH_MISMATCH:${key}`);
    }

    // 2. the descriptor lists agree with the artifacts
    const fromArtifacts = pkg.artifacts.map((a) => ({ id: a.id, kind: a.kind, sha256: a.sha256 }));
    if (!sameDescriptors(manifest.artifacts, fromArtifacts))
      issues.push("MANIFEST_ARTIFACTS_MISMATCH");
    if (!sameDescriptors(payload.evidenceReferences, fromArtifacts)) {
      issues.push("PAYLOAD_REFERENCES_MISMATCH");
    }
    if (manifest.artifactCount !== pkg.artifacts.length) issues.push("MANIFEST_COUNT_MISMATCH");

    // 3. payload and manifest hashes
    payloadSha256 = sha256OfCanonical(payload);
    if (payloadSha256 !== manifest.payloadSha256) issues.push("PAYLOAD_HASH_MISMATCH");
    manifestSha256 = sha256OfCanonical(manifest);
    if (manifestSha256 !== pkg.manifestSha256) issues.push("MANIFEST_HASH_MISMATCH");

    // 4. identity is consistent across package, manifest and payload
    const identity: [string, string, string][] = [
      ["PACKAGE_ID", pkg.packageId, manifest.packageId],
      ["ORGANIZATION", pkg.organizationId, manifest.organizationId],
      ["FACILITY", pkg.facilityId, manifest.facilityId],
      ["CASE", pkg.caseId, manifest.caseId],
      ["VERIFICATION", pkg.verificationId, manifest.verificationId],
      ["CREATED_AT", pkg.createdAt, manifest.createdAt],
      ["PAYLOAD_CASE", pkg.caseId, payload.caseIdentity.caseId],
      ["PAYLOAD_VERIFICATION", pkg.verificationId, payload.verification.verificationId],
    ];
    for (const [name, a, b] of identity) if (a !== b) issues.push(`IDENTITY_MISMATCH:${name}`);

    canonicalJson(pkg);
  } catch (e) {
    issues.push(`UNVERIFIABLE:${e instanceof Error ? e.message : String(e)}`);
  }
  return { valid: issues.length === 0, issues, payloadSha256, manifestSha256 };
}
