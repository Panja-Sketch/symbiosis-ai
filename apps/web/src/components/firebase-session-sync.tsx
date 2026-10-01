"use client";

import { onIdTokenChanged, signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { firebaseAuth } from "../lib/firebase-client";

/**
 * Keeps the server session cookie fresh: Firebase renews the ID token about hourly while a tab is
 * open and this posts each new token. A signed-out browser clears the cookie.
 */
export function SessionSync() {
  useEffect(() => {
    let last = "";
    return onIdTokenChanged(firebaseAuth(), async (user) => {
      if (user === null) return;
      const token = await user.getIdToken();
      if (token === last) return;
      last = token;
      await fetch("/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      });
    });
  }, []);
  return null;
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-small btn-quiet"
      onClick={async () => {
        await signOut(firebaseAuth());
        await fetch("/auth/session", { method: "DELETE" });
        router.replace("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
