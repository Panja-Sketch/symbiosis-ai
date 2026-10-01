import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { IDENTITY_COOKIE, buildSession, orgNamesFrom, peopleFrom } from "./identity";
import type { Session } from "./identity";
import { loadDirectory, loadMe } from "./loaders";
import type { DirectoryDto } from "./types";

/** The synthetic directory, once per request (undefined when the API cannot be reached). */
export const getDirectory = cache(async (): Promise<DirectoryDto | undefined> => {
  const r = await loadDirectory();
  return r.ok ? r.value : undefined;
});

/**
 * The current development identity, or undefined. The cookie only names an actor; the API's own
 * directory supplies organization, facilities and roles, and an unknown id yields no session.
 */
export const getSession = cache(async (): Promise<Session | undefined> => {
  const actorId = (await cookies()).get(IDENTITY_COOKIE)?.value;
  if (actorId === undefined || actorId === "") return undefined;
  const [me, dir] = await Promise.all([loadMe(actorId), getDirectory()]);
  return me.ok ? buildSession(me.value, dir?.organizations ?? []) : undefined;
});

export const getPeople = cache(async () => peopleFrom(await getDirectory()));
export const getOrgNames = cache(async () => orgNamesFrom(await getDirectory()));

/** For pages that need an identity: no cookie (or an unknown actor) sends the visitor to the entry page. */
export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (s === undefined) redirect("/");
  return s;
}
