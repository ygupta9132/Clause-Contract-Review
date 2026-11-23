import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import Link from "next/link";

import HeaderNav from "./header-nav";
import "./globals.css";

// Self-hosted by next/font, so there is no render-blocking request to Google at run time and
// no flash of a fallback face.
const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Clause - contract review assistant",
  description:
    "Upload a contract and review its important terms against a clear eight-point checklist. Every finding is grounded in the document.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.className}>
      <body>
        {/* ClerkProvider goes inside <body>, which is what the current SDK expects. */}
        <ClerkProvider
          appearance={{
            variables: {
              // Must track --accent-bright in globals.css. Clerk renders its own modals, so a
              // stale value here shows up as an off-brand button in the sign-in dialog.
              colorPrimary: "#e5322d",
              colorBackground: "#ffffff",
              borderRadius: "10px",
            },
          }}
        >
          <header className="top">
            {/* Same max-width and padding as .wrap, so the header aligns with the page content
                whether or not a scrollbar is present. */}
            <div className="top-inner">
              <Link href="/" className="brand">
                <span className="mark">C</span>
                Clause
                <span className="brand-sub">&nbsp;/ Contract review assistant</span>
              </Link>
              <HeaderNav />
            </div>
          </header>

          <main className="wrap">{children}</main>
        </ClerkProvider>
      </body>
    </html>
  );
}
