import { Suspense } from "react";
import type { Metadata } from "next";
import { NavigationTracker } from "@/components/nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Afterglow — Private AI companions",
  description: "A private, self-hosted character roleplay studio with lasting memory.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        {/* Records how deep into Afterglow each history entry is, so every
            Back control returns to the page the reader actually came from.
            Renders nothing; the boundary is for its use of the search
            parameters, which the app shell navigates by. */}
        <Suspense fallback={null}><NavigationTracker /></Suspense>
        {children}
      </body>
    </html>
  );
}
