"use client";

import { signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { firebaseAuth } from "../lib/firebase-client";

/** Email/password sign-in. The ID token goes to the server session route, which has the API verify it. */
export function LoginForm() {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(form: FormData) {
    setBusy(true);
    setError(undefined);
    try {
      const cred = await signInWithEmailAndPassword(
        firebaseAuth(),
        String(form.get("email") ?? ""),
        String(form.get("password") ?? ""),
      );
      const res = await fetch("/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: await cred.user.getIdToken() }),
      });
      if (!res.ok) {
        setError("This account is not authorized for Symbiosis.");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Sign-in failed. Check your email and password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form action={submit} className="card" aria-labelledby="login-h">
      <h2 id="login-h">Sign in</h2>
      <p className="muted">Use the account you were given for this prototype.</p>
      {error !== undefined && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <p>
        <label htmlFor="email">Email</label>
        <br />
        <input id="email" name="email" type="email" autoComplete="username" required />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <br />
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </p>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
