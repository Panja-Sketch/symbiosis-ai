import type { SourceMappingDefinition } from "@symbiosis/contracts";
import type { TenantDocumentStore } from "@symbiosis/repositories";
import { parseSourceMapping } from "./source-mapping";

/**
 * Versioned source-adapter catalog (S10, D-088). Built-in profiles (config/adapters) are version 1
 * and are never edited; a new version is published as an immutable record with who, when and why,
 * and becomes the active version. Earlier versions stay readable, because a payload that was
 * ingested under version N must always be explainable under version N.
 */
export type MappingVersionRecord = {
  readonly definition: SourceMappingDefinition;
  readonly builtin: boolean;
  readonly publishedBy: string;
  readonly publishedAt: string;
  readonly reason: string;
};

type ActivePointer = {
  readonly profileId: string;
  readonly activeVersion: number;
  readonly latestVersion: number;
};

export type ProfileSummary = {
  readonly profileId: string;
  readonly displayName: string;
  readonly vendorLabel: string;
  readonly description: string;
  readonly synthetic: boolean;
  readonly activeVersion: number;
  readonly versions: readonly {
    readonly version: number;
    readonly builtin: boolean;
    readonly publishedBy: string;
    readonly publishedAt: string;
    readonly reason: string;
  }[];
};

export type PublishResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false;
      readonly code: "UNKNOWN_PROFILE" | "INVALID" | "IMMUTABLE_FIELD";
      readonly issues: readonly string[];
    };

export interface AdapterCatalog {
  listProfiles(organizationId: string): Promise<readonly ProfileSummary[]>;
  getVersion(
    organizationId: string,
    profileId: string,
    version: number,
  ): Promise<MappingVersionRecord | undefined>;
  getActive(
    organizationId: string,
    profileId: string,
  ): Promise<SourceMappingDefinition | undefined>;
  /** Validates, stores as the next version and activates it. The caller audits. */
  publish(
    organizationId: string,
    candidate: unknown,
    meta: { readonly actorId: string; readonly reason: string; readonly at: string },
  ): Promise<PublishResult>;
  /** Re-activates an existing version (roll back). Returns false for an unknown version. */
  activate(organizationId: string, profileId: string, version: number): Promise<boolean>;
}

const versionId = (profileId: string, version: number) => `${profileId}@${version}`;

export function createAdapterCatalog(options: {
  readonly builtins: readonly SourceMappingDefinition[];
  readonly store: TenantDocumentStore;
}): AdapterCatalog {
  const { store } = options;
  const builtins = new Map(options.builtins.map((b) => [b.profileId, b]));
  for (const b of options.builtins) {
    if (!parseSourceMapping(b).ok) throw new Error(`built-in profile ${b.profileId} is invalid`);
  }

  const builtinRecord = (d: SourceMappingDefinition): MappingVersionRecord => ({
    definition: d,
    builtin: true,
    publishedBy: "SYSTEM",
    publishedAt: "1970-01-01T00:00:00.000Z",
    reason: "Built-in profile (config/adapters)",
  });

  async function pointer(org: string, profileId: string): Promise<ActivePointer> {
    return (
      (await store.get<ActivePointer>("adapterMappingActive", org, profileId)) ?? {
        profileId,
        activeVersion: 1,
        latestVersion: 1,
      }
    );
  }

  async function getVersion(org: string, profileId: string, version: number) {
    if (version === 1) {
      const b = builtins.get(profileId);
      return b === undefined ? undefined : builtinRecord(b);
    }
    return store.get<MappingVersionRecord>(
      "adapterMappingVersions",
      org,
      versionId(profileId, version),
    );
  }

  return {
    getVersion,

    async getActive(org, profileId) {
      if (!builtins.has(profileId)) return undefined;
      const p = await pointer(org, profileId);
      return (await getVersion(org, profileId, p.activeVersion))?.definition;
    },

    async listProfiles(org) {
      const out: ProfileSummary[] = [];
      for (const b of builtins.values()) {
        const p = await pointer(org, b.profileId);
        const versions = [];
        for (let v = 1; v <= p.latestVersion; v += 1) {
          const rec = await getVersion(org, b.profileId, v);
          if (rec === undefined) continue;
          versions.push({
            version: v,
            builtin: rec.builtin,
            publishedBy: rec.publishedBy,
            publishedAt: rec.publishedAt,
            reason: rec.reason,
          });
        }
        const active = (await getVersion(org, b.profileId, p.activeVersion))?.definition ?? b;
        out.push({
          profileId: b.profileId,
          displayName: active.displayName,
          vendorLabel: active.vendorLabel,
          description: active.description,
          synthetic: active.synthetic,
          activeVersion: p.activeVersion,
          versions,
        });
      }
      return out.sort((a, b) => a.profileId.localeCompare(b.profileId));
    },

    async publish(org, candidate, meta) {
      const profileId =
        typeof candidate === "object" && candidate !== null
          ? (candidate as { profileId?: unknown }).profileId
          : undefined;
      const base = typeof profileId === "string" ? builtins.get(profileId) : undefined;
      if (base === undefined) {
        return { ok: false, code: "UNKNOWN_PROFILE", issues: ["profileId is not a known profile"] };
      }
      // The version is assigned here, never taken from the request.
      const parsed = parseSourceMapping({ ...(candidate as object), version: 1 });
      if (!parsed.ok) return { ok: false, code: "INVALID", issues: parsed.issues };
      const d = parsed.value;
      if (d.sourceType !== base.sourceType || d.synthetic !== base.synthetic) {
        return {
          ok: false,
          code: "IMMUTABLE_FIELD",
          issues: ["sourceType and synthetic cannot change between versions"],
        };
      }
      if (meta.reason.trim().length < 3 || meta.reason.length > 300) {
        return { ok: false, code: "INVALID", issues: ["a reason (3-300 characters) is required"] };
      }
      const next = await store.update<ActivePointer>(
        "adapterMappingActive",
        org,
        d.profileId,
        (cur) => {
          const c = cur ?? { profileId: d.profileId, activeVersion: 1, latestVersion: 1 };
          // Reserve the number first; the version becomes active only after its record exists.
          return { doc: { ...c, latestVersion: c.latestVersion + 1 } };
        },
      );
      const version = next?.latestVersion ?? 2;
      const record: MappingVersionRecord = {
        definition: { ...d, version },
        builtin: false,
        publishedBy: meta.actorId,
        publishedAt: meta.at,
        reason: meta.reason.trim(),
      };
      await store.put("adapterMappingVersions", org, versionId(d.profileId, version), record);
      await store.update<ActivePointer>("adapterMappingActive", org, d.profileId, (cur) =>
        cur === undefined ? undefined : { doc: { ...cur, activeVersion: version } },
      );
      return { ok: true, version };
    },

    async activate(org, profileId, version) {
      if ((await getVersion(org, profileId, version)) === undefined) return false;
      await store.update<ActivePointer>("adapterMappingActive", org, profileId, (cur) => {
        const c = cur ?? { profileId, activeVersion: 1, latestVersion: 1 };
        return { doc: { ...c, activeVersion: version } };
      });
      return true;
    },
  };
}
