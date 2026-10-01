import { GoogleAuth } from "google-auth-library";

/**
 * Vertex AI access token from Application Default Credentials: on Cloud Run this is the service's
 * own runtime identity (metadata server), locally it is `gcloud auth application-default login`.
 * Tokens are short-lived and refreshed by the library; nothing is stored or configured as a secret.
 */
export function createAdcAccessTokenProvider(): () => Promise<string> {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  return async () => {
    const token = await auth.getAccessToken();
    if (typeof token !== "string" || token === "") throw new Error("no ADC access token");
    return token;
  };
}
