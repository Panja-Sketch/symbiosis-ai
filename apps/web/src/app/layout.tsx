import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { AppShell } from "../components/AppShell";
import { getDirectory, getSession } from "../lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Symbiosis AI", template: "%s · Symbiosis AI" },
  description:
    "Risk improvement verification: a recommendation to reduce risk is not the same as verified risk reduction.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { readonly children: ReactNode }) {
  const [session, directory] = await Promise.all([getSession(), getDirectory()]);
  return (
    <html lang="en">
      <body>
        <AppShell session={session} directory={directory}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
