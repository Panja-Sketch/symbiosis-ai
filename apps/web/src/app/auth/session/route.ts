import { cookies } from "next/headers";
import { authMode, SESSION_COOKIE } from "../../../lib/auth-mode";
import { apiMe } from "../../../lib/api";

/**
 * Stores the person's ID token in an HttpOnly cookie, but only after the API has verified it and
 * resolved an actor for it. The token is never readable by page scripts; the API re-verifies it on
 * every call, so an expired or revoked token simply stops working.
 */
export async function POST(request: Request): Promise<Response> {
  if (authMode() !== "token") return new Response(null, { status: 404 });
  let idToken: unknown;
  try {
    idToken = ((await request.json()) as { idToken?: unknown }).idToken;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof idToken !== "string" || idToken === "" || idToken.length > 8192) {
    return new Response(null, { status: 400 });
  }
  const me = await apiMe(idToken);
  if (!me.ok) return new Response(null, { status: me.status === 0 ? 503 : 401 });
  (await cookies()).set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 3300,
  });
  return new Response(null, { status: 204 });
}

export async function DELETE(): Promise<Response> {
  (await cookies()).delete(SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
