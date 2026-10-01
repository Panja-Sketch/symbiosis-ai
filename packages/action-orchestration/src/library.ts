/**
 * Approved action library (config/action-library/*.json). Actions are stable IDs with operational
 * wording, never executable instructions. The platform is RECOMMEND_ONLY, so an entry that
 * claims to control equipment is rejected when the library is parsed.
 */
export type ActionLibraryEntry = {
  readonly actionLibraryId: string;
  readonly title: string;
  readonly description: string;
  readonly hazardTypes: readonly string[];
  readonly controlsEquipment: false;
};

export type ActionLibrary = {
  readonly version: string;
  readonly actions: readonly ActionLibraryEntry[];
};

const ID_PATTERN = /^ACT-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;

export function parseActionLibrary(value: unknown): ActionLibrary {
  const v = value as ActionLibrary | null;
  if (
    v === null ||
    typeof v !== "object" ||
    typeof v.version !== "string" ||
    !Array.isArray(v.actions)
  ) {
    throw new Error("invalid action library");
  }
  const seen = new Set<string>();
  for (const a of v.actions) {
    if (
      typeof a?.actionLibraryId !== "string" ||
      !ID_PATTERN.test(a.actionLibraryId) ||
      seen.has(a.actionLibraryId) ||
      typeof a.title !== "string" ||
      a.title.trim() === "" ||
      typeof a.description !== "string" ||
      !Array.isArray(a.hazardTypes) ||
      a.hazardTypes.length === 0
    ) {
      throw new Error(`invalid action library entry: ${String(a?.actionLibraryId)}`);
    }
    if ((a as { controlsEquipment: unknown }).controlsEquipment !== false) {
      throw new Error(`action ${a.actionLibraryId} must not control equipment (RECOMMEND_ONLY)`);
    }
    seen.add(a.actionLibraryId);
  }
  return v;
}

export function findAction(library: ActionLibrary, id: string): ActionLibraryEntry | undefined {
  return library.actions.find((a) => a.actionLibraryId === id);
}

/** Actions that apply to a hazard type. */
export function actionsFor(
  library: ActionLibrary,
  hazardType: string,
): readonly ActionLibraryEntry[] {
  return library.actions.filter((a) => a.hazardTypes.includes(hazardType));
}
