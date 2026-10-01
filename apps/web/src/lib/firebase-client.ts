"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";

/**
 * Browser-side Firebase Auth. These values are PUBLIC web configuration (an API key that only
 * identifies the project, not a secret); server credentials never reach the client. They are
 * inlined at build time from NEXT_PUBLIC_* variables.
 */
export function firebaseAuth() {
  const config = {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID ?? "",
  };
  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  return getAuth(app);
}
