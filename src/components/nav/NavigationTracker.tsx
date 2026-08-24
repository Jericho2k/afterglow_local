"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { nextDepth, readLastDepth, stampedDepth, takeClaimedDepth, withDepth, writeLastDepth } from "@/lib/back-navigation";

/**
 * Stamps each history entry with how deep into Afterglow it is.
 *
 * Mounted once in the root layout, so every route takes part without any page
 * implementing navigation logic of its own. It watches the router rather than
 * intercepting links, which means it also sees the app shell's own view
 * changes — those are query-string navigations on `/`, which is why the search
 * parameters are a dependency and not only the path.
 *
 * An entry that already carries a stamp is one the reader has returned to, so
 * it is recorded rather than renumbered; that is what makes going back and
 * forward repeatedly stay consistent. It renders nothing and never blocks: if
 * session storage or history state is unavailable, Back simply falls back to a
 * safe in-app route.
 */
export function NavigationTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();

  useEffect(() => {
    const existing = stampedDepth(window.history.state);
    if (existing !== null) { writeLastDepth(window.sessionStorage, existing); return; }
    // A replace that told us where it was going wins over counting up from the
    // last entry, because a replaced entry does not add depth.
    const depth = takeClaimedDepth(window.sessionStorage) ?? nextDepth(readLastDepth(window.sessionStorage));
    try {
      // The router's own state is carried across untouched; only our key is
      // added, and the URL is left exactly as it is.
      window.history.replaceState(withDepth(window.history.state, depth), "");
    } catch { /* An unavailable history state only costs the deep-link fallback. */ }
    writeLastDepth(window.sessionStorage, depth);
  }, [pathname, search]);

  return null;
}
