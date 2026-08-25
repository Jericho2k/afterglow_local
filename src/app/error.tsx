"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * The last line of defence for a rendering failure.
 *
 * This is not a substitute for fixing what threw — the crash this was written
 * alongside was a real one, and it was fixed at its source. It exists because
 * the alternative to a friendly panel is a blank page: a single bad value in
 * one card used to unmount the entire shell, leaving nothing to read and
 * nothing to press. The reader gets a way back and the error still reaches the
 * console, so nothing is hidden from whoever has to diagnose it.
 */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("Afterglow render error", error);
  }, [error]);

  return <main style={{
    minHeight: "100dvh", display: "grid", placeContent: "center", justifyItems: "center",
    gap: 14, padding: 30, textAlign: "center", background: "#0b080d", color: "#f6eff4",
  }}>
    <span aria-hidden style={{ fontSize: 26, color: "#e879a9" }}>✦</span>
    <h1 style={{ margin: 0, fontFamily: "var(--font-serif), Georgia, serif", fontSize: 26, fontWeight: 600 }}>
      Something went wrong
    </h1>
    <p style={{ margin: 0, maxWidth: "42ch", fontSize: 13.5, lineHeight: 1.6, color: "#a99cab" }}>
      This page could not finish rendering. Nothing you saved has been lost — try again, or head back to Afterglow.
    </p>
    <div style={{ display: "flex", gap: 10, marginTop: 6 }}>
      <button
        type="button"
        onClick={reset}
        style={{
          border: 0, borderRadius: 12, cursor: "pointer", padding: "11px 18px",
          background: "linear-gradient(96deg,#e879a9,#a874f0)", color: "#2a1020", fontSize: 13, fontWeight: 620,
        }}
      >Try again</button>
      <Link
        href="/"
        style={{
          borderRadius: 12, padding: "11px 18px", textDecoration: "none",
          border: "1px solid rgba(255,255,255,.09)", color: "#f6eff4", fontSize: 13, fontWeight: 560,
        }}
      >Return to Afterglow</Link>
    </div>
  </main>;
}
