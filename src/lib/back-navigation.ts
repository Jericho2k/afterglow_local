/**
 * What "Back" means.
 *
 * Back returns to the page the reader actually came from, which is a question
 * about this tab's history rather than about the page they are standing on. A
 * creation opened from Discovery goes back to Discovery, the same creation
 * opened from a search goes back to that search with its results and scroll
 * intact, and a world opened from a creation goes back to that creation —
 * without any of those pages knowing where they were entered from. Handing the
 * decision to the router is what preserves that state; a Back button that
 * navigated to a route it composed itself would throw all of it away.
 *
 * The one thing the browser will not tell us is whether going back would leave
 * Afterglow altogether, and that is the whole difficulty. So each history entry
 * the app creates is stamped with how deep into Afterglow it is: the entry the
 * tab arrived on is depth 0, and every page opened from inside the app is one
 * deeper. Depth 0 means there is nothing of ours underneath — the page was deep
 * linked, from a bookmark, a shared URL or a fresh tab — and Back goes to a
 * sensible in-app destination instead of stepping outside the app or doing
 * nothing at all.
 *
 * A stamp lives on the history entry itself, so it survives a reload and the
 * feed rewriting its own query string in place, and it cannot drift the way a
 * reconstructed list of visited URLs does. Session storage holds only the last
 * depth seen, which is what a newly pushed entry counts up from.
 */

/** Where the depth is kept on a history entry, alongside the router's own state. */
export const depthStateKey = "afterglowDepth";

/** Where the last depth seen in this tab is kept, for entries not yet stamped. */
export const navigationDepthKey = "afterglow:nav:depth";

/**
 * Where a depth claimed in advance is kept.
 *
 * A router replace builds a fresh history state, so our stamp on the entry
 * being replaced does not survive it and the tracker would otherwise count the
 * replacement as a step deeper. The one place that replaces deliberately — Back
 * sending a deep-linked page to its fallback — says up front how deep the
 * result is, and the tracker honours that claim once.
 */
export const pendingDepthKey = "afterglow:nav:pending";

/** The entry a tab arrives on. Nothing of ours sits below it. */
export const rootDepth = 0;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

/**
 * The depth stamped on a history entry, or null for one we have never seen —
 * an entry pushed a moment ago, or the page a tab was opened straight onto.
 */
export function stampedDepth(state: unknown): number | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[depthStateKey];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** The stamp to put on an entry, given the last depth this tab recorded. */
export function nextDepth(lastSeen: number | null) {
  return lastSeen === null ? rootDepth : lastSeen + 1;
}

/** A history state carrying our stamp without disturbing the router's own keys. */
export function withDepth(state: unknown, depth: number): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state as Record<string, unknown> : {}), [depthStateKey]: depth };
}

export function readLastDepth(storage: StorageLike): number | null {
  try {
    const raw = storage?.getItem(navigationDepthKey);
    if (raw === null || raw === undefined) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

export function writeLastDepth(storage: StorageLike, depth: number) {
  try { storage?.setItem(navigationDepthKey, String(depth)); }
  catch { /* A blocked store only costs the deep-link fallback. */ }
}

/** States the depth of the entry a deliberate replace is about to create. */
export function claimDepth(storage: StorageLike, depth: number) {
  try { storage?.setItem(pendingDepthKey, String(depth)); }
  catch { /* Without the claim the replacement merely counts as one deeper. */ }
}

/** Reads a claim and spends it, so it can never apply to a later navigation. */
export function takeClaimedDepth(storage: StorageLike): number | null {
  try {
    const raw = storage?.getItem(pendingDepthKey) ?? null;
    storage?.removeItem(pendingDepthKey);
    if (raw === null) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch { return null; }
}

/**
 * How deep the reader currently is.
 *
 * The stamp on the entry is authoritative. An entry with no stamp yet has only
 * just been pushed, and the safe reading of "we do not know" is the one that
 * cannot send the reader out of the app: the depth recorded a moment ago.
 */
export function currentDepth(state: unknown, storage: StorageLike) {
  return stampedDepth(state) ?? readLastDepth(storage) ?? rootDepth;
}

/** True when there is a previous Afterglow page to return to in this tab. */
export function canGoBack(depth: number) {
  return depth > rootDepth;
}

export type BackDestination = { type: "history" } | { type: "fallback"; href: string };

/**
 * Where Back should go.
 *
 * `history` hands the decision to the router, which is what restores the
 * previous page's own filters, results and scroll. `fallback` is only ever
 * reached by a page with no in-app history behind it.
 */
export function resolveBack(depth: number, fallback: string): BackDestination {
  return canGoBack(depth) ? { type: "history" } : { type: "fallback", href: fallback };
}

/** Where a page sends a reader who arrived at it directly. */
export const backFallbacks = {
  /** Discovery, which is the home of the app shell. */
  creation: "/",
  /** The Worlds page, which is where a world is browsed from. */
  world: "/?view=worlds",
} as const;
