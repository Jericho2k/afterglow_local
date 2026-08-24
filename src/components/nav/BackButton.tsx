"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { claimDepth, currentDepth, resolveBack, rootDepth } from "@/lib/back-navigation";

/**
 * The top-left Back control.
 *
 * One control for every page, so Back means the same thing everywhere: return
 * to whatever the reader was actually looking at. It hands the decision to the
 * router when this tab has in-app history, which is what lets the previous page
 * restore its own filters, results and scroll position, and it only uses
 * `fallback` when the page was opened directly and there is nothing behind it.
 *
 * `fallback` is therefore not "where Back goes", it is "where a deep link goes
 * instead of nowhere". No page should pass a route it merely thinks is likely.
 */
export function BackButton({ fallback, label = "Back", className }: {
  fallback: string;
  label?: string;
  className?: string;
}) {
  const router = useRouter();

  function goBack() {
    const destination = resolveBack(currentDepth(window.history.state, window.sessionStorage), fallback);
    if (destination.type === "history") { router.back(); return; }
    // The fallback replaces the deep-linked entry rather than stacking on top
    // of it, so the destination is the tab's root too and Back there does not
    // bounce straight back to the page the reader just left.
    claimDepth(window.sessionStorage, rootDepth);
    router.replace(destination.href);
  }

  return <button type="button" className={className} aria-label={label} onClick={goBack}>
    <ArrowLeft size={18} aria-hidden />
  </button>;
}
