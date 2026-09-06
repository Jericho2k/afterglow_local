/**
 * What this tab has already been shown of a creation.
 *
 * The creation page is a client surface: the router unmounts it when a reader
 * opens a cast member, so pressing Back remounts it with nothing and the whole
 * creation is fetched again. This cache is what stops that being a blank page —
 * a Back that finds an entry paints in the first frame and revalidates behind
 * it. It is per-tab, bounded, and holds only what the API already returned to
 * this reader.
 *
 * It lives here, rather than in the page that reads it, for one reason: a save
 * has to be able to DELETE an entry. Saving an edit navigates back to the
 * creation, which remounts the page, which paints the cached copy — the one
 * fetched before the edit — and only then replaces it with the fetch. For a
 * banner or a focal point that is a visible flash of the old presentation, and
 * on a failed revalidation it is the old presentation full stop. The editor
 * therefore forgets the creation it just wrote, and the page it returns to has
 * nothing stale to paint.
 *
 * The store hangs off `globalThis` rather than off this module's scope so that
 * the page's chunk and the editor's chunk cannot end up holding two of them:
 * an invalidation that reached a second copy of the map would be a no-op that
 * looks exactly like a fix.
 */

type CacheEntry = { detail: unknown; comments: unknown };

const registry = globalThis as typeof globalThis & { __afterglowCreationCache?: Map<string, CacheEntry> };
const store: Map<string, CacheEntry> = registry.__afterglowCreationCache ??= new Map<string, CacheEntry>();

/**
 * Bounded, because a reader can walk a long way through a cast: the oldest
 * entries are dropped, so a browsing session cannot grow this without limit.
 */
export const creationCacheLimit = 12;

/** What this tab holds for a creation, or undefined when it holds nothing. */
export function readCreation<Detail, Comment>(creationId: string) {
  const entry = store.get(creationId);
  return entry as { detail: Detail | null; comments: Comment[] | null } | undefined;
}

/** Records part of what was fetched, keeping the rest of the entry intact. */
export function rememberCreation<Detail, Comment>(creationId: string, patch: Partial<{ detail: Detail; comments: Comment[] }>) {
  const existing = store.get(creationId) ?? { detail: null, comments: null };
  // Deleted and re-set so insertion order tracks use, which is what makes the
  // eviction below drop the least recently written entry.
  store.delete(creationId);
  store.set(creationId, { ...existing, ...patch });
  while (store.size > creationCacheLimit) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Drops what this tab remembers about a creation.
 *
 * Called after a successful save. The next visit fetches, which is the whole
 * point: a creator who has just changed their artwork must not be shown the
 * copy that predates the change, however briefly.
 */
export function forgetCreation(creationId: string) {
  store.delete(creationId);
}

/** Test seam. Nothing in the product clears the whole cache. */
export function resetCreationCacheForTesting() {
  store.clear();
}
