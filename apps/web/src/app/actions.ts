"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import type { ApiResult } from "../lib/api";
import {
  acknowledgeAction,
  acknowledgeCase,
  assignAction,
  grantSharing,
  reportAction,
  revokeSharing,
} from "../lib/commands";
import { SESSION_COOKIE, authMode } from "../lib/auth-mode";
import { IDENTITY_COOKIE, landingFor, personaOf, safeLocalPath } from "../lib/identity";
import { loadDirectory } from "../lib/loaders";

/**
 * Server Actions: thin form handlers. Each reads a form, forwards one command to the API as the
 * current development identity, and redirects back with a fixed notice or the API's own error.
 * They contain no lifecycle, consent or verification rules.
 */

const text = (f: FormData, k: string): string => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

async function actor(): Promise<string> {
  const token = authMode() === "token";
  const id = (await cookies()).get(token ? SESSION_COOKIE : IDENTITY_COOKIE)?.value;
  if (id === undefined || id === "") redirect(token ? "/login" : "/");
  // Token mode: the value is only a presence check; the API reads the token cookie itself.
  return token ? "session" : id;
}

function finish(path: string, r: ApiResult<unknown>, notice: string): never {
  revalidatePath(path);
  if (r.ok) redirect(`${path}?notice=${notice}#feedback`);
  const detail = [r.message, ...(r.details ?? [])].join(" ").slice(0, 240);
  redirect(
    `${path}?error=${encodeURIComponent(r.code)}&msg=${encodeURIComponent(detail)}#feedback`,
  );
}

const casePath = (f: FormData) => `/operations/cases/${encodeURIComponent(text(f, "caseId"))}`;

export async function switchIdentity(form: FormData): Promise<void> {
  if (authMode() === "token") redirect("/login"); // no identity switching in the cloud
  const actorId = text(form, "actorId");
  const dir = await loadDirectory();
  const identity = dir.ok ? dir.value.actors.find((a) => a.actorId === actorId) : undefined;
  if (identity === undefined) redirect("/?error=unknown-identity");
  (await cookies()).set(IDENTITY_COOKIE, identity.actorId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
  redirect(landingFor(personaOf(identity), safeLocalPath(text(form, "returnTo"))));
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(IDENTITY_COOKIE);
  redirect("/");
}

export async function acknowledgeCaseAction(form: FormData): Promise<void> {
  const id = await actor();
  finish(
    casePath(form),
    await acknowledgeCase(id, text(form, "caseId"), text(form, "note")),
    "acknowledged",
  );
}

export async function assignActionAction(form: FormData): Promise<void> {
  const id = await actor();
  finish(
    casePath(form),
    await assignAction(
      id,
      text(form, "caseId"),
      text(form, "actionLibraryId"),
      text(form, "assigneeId"),
    ),
    "assigned",
  );
}

export async function acknowledgeActionAction(form: FormData): Promise<void> {
  const id = await actor();
  finish(
    casePath(form),
    await acknowledgeAction(id, text(form, "caseId"), text(form, "actionId")),
    "assignment-acknowledged",
  );
}

export async function reportActionAction(form: FormData): Promise<void> {
  const id = await actor();
  finish(
    casePath(form),
    await reportAction(id, text(form, "caseId"), {
      actionLibraryId: text(form, "actionLibraryId"),
      actionId: text(form, "actionId"),
      notes: text(form, "notes"),
    }),
    "reported",
  );
}

/** A date input (`YYYY-MM-DD`) becomes the end of that day, UTC; empty means "until revoked". */
const endOfDay = (date: string): string | undefined =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.000Z` : undefined;

export async function grantSharingAction(form: FormData): Promise<void> {
  const id = await actor();
  const back = safeLocalPath(text(form, "returnTo")) ?? casePath(form);
  const expiresAt = endOfDay(text(form, "expiresOn"));
  finish(
    back,
    await grantSharing(id, {
      recipientOrganizationId: text(form, "recipientOrganizationId"),
      facilityId: text(form, "facilityId"),
      scopes: form.getAll("scope").filter((s): s is string => typeof s === "string"),
      ...(expiresAt !== undefined && { expiresAt }),
    }),
    "shared",
  );
}

export async function revokeSharingAction(form: FormData): Promise<void> {
  const id = await actor();
  const back = safeLocalPath(text(form, "returnTo")) ?? casePath(form);
  finish(back, await revokeSharing(id, text(form, "agreementId"), text(form, "reason")), "revoked");
}
