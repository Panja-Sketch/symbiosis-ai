/**
 * How this web server identifies people. `demo` (default, local development only): a cookie names
 * a synthetic actor. `token` (cloud): the browser signs in with the identity provider and the
 * server forwards the person's ID token to the API, which verifies it and decides everything.
 * Set per deployment with SYMBIOSIS_AUTH_MODE; the browser cannot change it.
 */
export type AuthMode = "demo" | "token";
export const authMode = (): AuthMode =>
  process.env.SYMBIOSIS_AUTH_MODE === "token" ? "token" : "demo";
export const SESSION_COOKIE = "symbiosis_session";
