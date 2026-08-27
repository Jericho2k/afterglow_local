"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compass, Search, SlidersHorizontal, Sparkles, UserRoundPlus, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { AppMenuButton } from "@/components/ui";
import { NotificationBell } from "@/components/shell/NotificationBell";
import { creationTypeLabels } from "@/lib/creation";
import {
  activeFilterCount, applyPreferences, discoveryPageSize, discoverySearchParams, discoverySortHints,
  discoverySortLabels, discoverySorts, emptyDiscoveryPreferences, isFilteredQuery, isFollowingSort,
  parseDiscoveryQuery, parseSearchTerm, preferencesFromQuery, queryStatesIntent, samePreferences,
  type DiscoveryPreferences, type DiscoveryQuery, type DiscoverySort,
} from "@/lib/discovery";
import { toggleCreationSave } from "@/lib/saves";
import type { CreationSummary } from "@/lib/types";
import { CreationGrid, CreationGridSkeleton, FeedState } from "./CreationGrid";
import { FilterSheet } from "./FilterSheet";
import styles from "./feed.module.css";

/**
 * Discovery.
 *
 * One page of creations per request, ordered by a real column, filtered by the
 * platform tag taxonomy and searched across titles, taglines, tags, creator
 * hashtags and creator names. The feed keeps its state in the address bar so a
 * filtered view can be shared and restored, and keeps the loaded page in
 * session storage so returning from a creation lands where it was left rather
 * than at the top.
 */

type Page = { creations: CreationSummary[]; hasMore: boolean; nextOffset: number; followingCreators?: number | null };
type Restorable = { key: string; creations: CreationSummary[]; hasMore: boolean; nextOffset: number; scrollTop: number };

const restoreKey = "afterglow:discovery";
/** Enough to restore several scrolled screens without filling session storage. */
const restoreLimit = 120;

/** Identifies a query for restoration; the ordering and every filter is part of it. */
function queryKey(query: DiscoveryQuery) {
  return discoverySearchParams({ ...query, offset: 0 }).toString();
}

function readRestorable(key: string): Restorable | null {
  try {
    const raw = window.sessionStorage.getItem(restoreKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Restorable;
    return parsed && parsed.key === key && Array.isArray(parsed.creations) ? parsed : null;
  } catch { return null; }
}

export function DiscoveryFeed({ onOpenMenu }: { onOpenMenu?: () => void }) {
  const [query, setQuery] = useState<DiscoveryQuery>(() => parseDiscoveryQuery(new URLSearchParams()));
  // What is actually in the search box, which leads the query by a debounce.
  const [term, setTerm] = useState("");
  const [ready, setReady] = useState(false);
  const [creations, setCreations] = useState<CreationSummary[]>([]);
  const [page, setPage] = useState<{ hasMore: boolean; nextOffset: number }>({ hasMore: false, nextOffset: 0 });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [stuck, setStuck] = useState(false);
  /** How many creators this account follows. Null until a Following feed says. */
  const [followingCreators, setFollowingCreators] = useState<number | null>(null);

  const scrollerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef<Restorable | null>(null);
  const snapshotRef = useRef<Restorable | null>(null);
  // Set once, before the first preference response can land, so a preference
  // arriving late never overwrites a filter the reader has already changed.
  const preferencesApplied = useRef(false);
  // What the server currently holds, so an unchanged query writes nothing.
  const savedPreferences = useRef<DiscoveryPreferences | null>(null);

  /**
   * What to show on arrival.
   *
   * Two different questions, answered in a strict order:
   *
   *   1. Does the URL already say? A shared link, a hashtag tap, or a Back
   *      restoring the previous view all arrive with the answer in the address
   *      bar, and it always wins — otherwise Back would return somewhere the
   *      reader had never been.
   *   2. Otherwise, what does this account generally want? That is fetched
   *      once, applied once, and never fought over again: `preferencesApplied`
   *      is set before the request resolves, so a slow response cannot land on
   *      top of a filter the reader changed while waiting.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const initial = parseDiscoveryQuery(params);
    restoredRef.current = readRestorable(queryKey(initial));
    setTerm(initial.hashtag ? `#${initial.hashtag}` : initial.search);

    if (queryStatesIntent(params) || restoredRef.current) {
      preferencesApplied.current = true;
      savedPreferences.current = null;
      setQuery(initial);
      setReady(true);
      return;
    }

    let cancelled = false;
    api<{ discovery: DiscoveryPreferences }>("/api/preferences")
      .then(({ discovery }) => {
        if (cancelled) return;
        const preferences = { ...emptyDiscoveryPreferences, ...discovery };
        savedPreferences.current = preferences;
        setQuery(applyPreferences(initial, preferences));
      })
      .catch(() => { if (!cancelled) setQuery(initial); })
      .finally(() => {
        if (cancelled) return;
        preferencesApplied.current = true;
        setReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  /**
   * Remember what the reader settled on.
   *
   * Only the structured part — the ordering and the filters — and never the
   * search term. Clearing counts: a creator who cleared their filters wants
   * them cleared next time too, so an empty preference is written rather than
   * treated as "nothing to save", which is what would make Clear appear to
   * undo itself on the next visit.
   */
  useEffect(() => {
    if (!ready || !preferencesApplied.current) return;
    const next = preferencesFromQuery(query);
    if (savedPreferences.current && samePreferences(savedPreferences.current, next)) return;
    const timer = window.setTimeout(() => {
      savedPreferences.current = next;
      void api("/api/preferences", { method: "PATCH", body: JSON.stringify(next) }).catch(() => {
        // A preference that failed to save is not worth interrupting browsing
        // for; the next change tries again.
        savedPreferences.current = null;
      });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [query, ready]);

  const key = queryKey(query);

  // The address bar mirrors the feed. `replaceState` rather than a push so a
  // search does not bury the previous page under one history entry per
  // keystroke, while the URL stays shareable and survives a reload.
  useEffect(() => {
    if (!ready) return;
    const params = discoverySearchParams({ ...query, offset: 0 });
    const view = new URLSearchParams(window.location.search).get("view");
    if (view) params.set("view", view);
    const search = params.toString();
    window.history.replaceState(window.history.state, "", search ? `/?${search}` : "/");
  }, [key, query, ready]);

  const load = useCallback(async (target: DiscoveryQuery, mode: "replace" | "append") => {
    const params = discoverySearchParams(target);
    if (mode === "append") params.set("offset", String(target.offset));
    if (mode === "replace") setLoading(true); else setLoadingMore(true);
    setError("");
    try {
      const data = await api<Page>(`/api/discovery?${params.toString()}`);
      setCreations((current) => mode === "append" ? [...current, ...data.creations] : data.creations);
      setPage({ hasMore: data.hasMore, nextOffset: data.nextOffset });
      if (typeof data.followingCreators === "number") setFollowingCreators(data.followingCreators);
    } catch (reason) {
      if (mode === "replace") setCreations([]);
      setError(reason instanceof Error ? reason.message : "Discovery is unavailable right now");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const restored = restoredRef.current;
    if (restored) {
      // Returning from a creation: put back exactly what was on screen.
      restoredRef.current = null;
      setCreations(restored.creations);
      setPage({ hasMore: restored.hasMore, nextOffset: restored.nextOffset });
      setLoading(false);
      requestAnimationFrame(() => { if (scrollerRef.current) scrollerRef.current.scrollTop = restored.scrollTop; });
      return;
    }
    void load({ ...query, offset: 0 }, "replace");
  }, [key, load, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the snapshot fresh so the cleanup below can write it without holding
  // a stale closure over the state it is saving.
  useEffect(() => {
    snapshotRef.current = {
      key,
      creations: creations.slice(0, restoreLimit),
      hasMore: page.hasMore,
      nextOffset: Math.min(page.nextOffset, restoreLimit),
      scrollTop: 0,
    };
  }, [creations, key, page]);

  useEffect(() => () => {
    const snapshot = snapshotRef.current;
    if (!snapshot || !snapshot.creations.length) return;
    try {
      window.sessionStorage.setItem(restoreKey, JSON.stringify({ ...snapshot, scrollTop: scrollerRef.current?.scrollTop ?? 0 }));
    } catch { /* A full or unavailable store only costs scroll restoration. */ }
  }, []);

  // Debounce what is typed into the query that actually fetches.
  useEffect(() => {
    if (!ready) return;
    const parsed = parseSearchTerm(term);
    if (parsed.search === query.search && parsed.hashtag === query.hashtag) return;
    const timer = window.setTimeout(() => setQuery((current) => ({ ...current, ...parsed, offset: 0 })), 300);
    return () => window.clearTimeout(timer);
  }, [term, ready, query.search, query.hashtag]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !page.hasMore) return;
    void load({ ...query, offset: page.nextOffset }, "append");
  }, [load, loading, loadingMore, page, query]);

  // Auto-advance a little before the end of the list rather than exactly at it.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollerRef.current;
    if (!sentinel || !root || !page.hasMore) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadMore();
    }, { root, rootMargin: "600px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, page.hasMore]);

  const toggleSave = useCallback(async (creation: CreationSummary) => {
    // Optimistic, reconciled with the server's own total, reverted on failure.
    const failure = await toggleCreationSave(creation, (state) => setCreations((items) => items.map((item) =>
      item.id === creation.id ? { ...item, ...state } : item)));
    if (failure) setNotice(failure);
  }, []);

  const update = useCallback((changes: Partial<DiscoveryQuery>) => {
    setQuery((current) => ({ ...current, ...changes, offset: 0 }));
  }, []);

  const filterCount = activeFilterCount(query);
  const filtered = isFilteredQuery(query);
  const following = isFollowingSort(query.sort);
  const activeChips = useMemo(() => [
    ...query.types.map((type) => ({ label: creationTypeLabels[type], clear: () => update({ types: query.types.filter((item) => item !== type) }) })),
    ...query.tags.map((tag) => ({ label: tag, clear: () => update({ tags: query.tags.filter((item) => item !== tag) }) })),
    ...(query.includeAdult ? [{ label: "18+ included", clear: () => update({ includeAdult: false }) }] : []),
  ], [query.includeAdult, query.tags, query.types, update]);

  const clearEverything = useCallback(() => {
    setTerm("");
    setQuery((current) => ({ ...current, search: "", hashtag: "", tags: [], types: [], includeAdult: false, offset: 0 }));
  }, []);

  return <section
    className={styles.feed}
    ref={scrollerRef}
    onScroll={(event) => setStuck(event.currentTarget.scrollTop > 8)}
    aria-label="Discover creations"
  >
    <header className={styles.head}>
      <span className={styles.eyebrow}>Public creations from Afterglow creators</span>
      <h1 className={styles.title}>Discover<Sparkles size={20} className={styles.titleSpark} aria-hidden /></h1>
      <p className={styles.lede}>{following
        ? "Everything the creators you follow have published, newest first."
        : "Characters, casts and scenario roleplay, published by their creators. Save anything you want to come back to."}</p>
    </header>

    <div className={`${styles.controls} ${stuck ? styles.controlsStuck : ""}`}>
      <div className={styles.controlRow}>
        {onOpenMenu && <AppMenuButton className={styles.menuButton} onOpen={onOpenMenu} />}
        <label className={styles.search}>
          <Search size={15} aria-hidden />
          <input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search creations, tags, #hashtags"
            aria-label="Search creations"
            enterKeyHint="search"
          />
          {term && <button type="button" className={styles.clearSearch} aria-label="Clear search" onClick={() => setTerm("")}><X size={14} /></button>}
        </label>
        <button
          type="button"
          className={`${styles.filterButton} ${filterCount ? styles.filterButtonActive : ""}`}
          aria-haspopup="dialog"
          onClick={() => setFiltersOpen(true)}
        >
          <SlidersHorizontal size={15} aria-hidden />
          <span className={styles.filterButtonLabel}>Filters</span>
          {filterCount > 0 && <span className={styles.filterCount}>{filterCount}</span>}
        </button>
        {/* Discovery draws its own header rather than using PageHeader, so the
            bell is placed here explicitly. Same control, same shared count. */}
        <NotificationBell className={styles.menuButton} />
      </div>

      {/* A group of toggles rather than an ARIA tablist: there is no tabpanel
          here, only one grid that re-sorts. */}
      <div className={styles.tabs} role="group" aria-label="Feed ordering">
        {discoverySorts.map((sort: DiscoverySort) => <button
          key={sort}
          type="button"
          aria-pressed={query.sort === sort}
          title={discoverySortHints[sort]}
          className={`${styles.tab} ${query.sort === sort ? styles.tabActive : ""}`}
          onClick={() => update({ sort })}
        >{discoverySortLabels[sort]}</button>)}
      </div>
    </div>

    {activeChips.length > 0 && <div className={styles.activeFilters}>
      {activeChips.map((chip) => <button key={chip.label} type="button" className={styles.activeChip} onClick={chip.clear}>
        {chip.label}<X size={12} aria-hidden />
      </button>)}
      <button type="button" className={styles.clearAll} onClick={clearEverything}>Clear all</button>
    </div>}

    {loading
      ? <CreationGridSkeleton count={discoveryPageSize / 2} />
      : error
        ? <div className={styles.grid}><FeedState
            icon={<Compass size={26} />}
            title="Discovery is unavailable"
            description={error}
            action={{ label: "Try again", onClick: () => void load({ ...query, offset: 0 }, "replace") }}
          /></div>
        : creations.length === 0
          ? <div className={styles.grid}>{following
              /*
               * Two different empty Following feeds, and they are different
               * problems. "You follow nobody" has an action — go and find
               * somebody — and "the people you follow have not published" has
               * none, so offering one would be pretending there is something
               * wrong that the reader could fix.
               */
              ? <FeedState
                  icon={<UserRoundPlus size={26} />}
                  title={followingCreators ? "Nothing new from them yet" : "You are not following anyone yet"}
                  description={followingCreators
                    ? "The creators you follow have not published anything public yet. When they do, it appears here first — and you will get a notification."
                    : "Follow a creator and everything they publish shows up here, newest first. Open any creation and tap the creator to see their work."}
                  action={followingCreators ? undefined : { label: "Browse creations", onClick: () => update({ sort: "popular" }) }}
                />
              : <FeedState
                  icon={<Search size={26} />}
                  title={filtered ? "Nothing matches that yet" : "No published creations yet"}
                  description={filtered
                    ? "Try fewer filters, a different ordering, or a broader search term."
                    : "When creators publish a character, cast or scenario it appears here. Your own creations live in your library."}
                  action={filtered ? { label: "Clear filters", onClick: clearEverything } : undefined}
                />}</div>
          : <>
              <CreationGrid creations={creations} onToggleSave={toggleSave} />
              <div ref={sentinelRef} className={styles.sentinel} aria-hidden />
              {page.hasMore
                ? <button type="button" className={styles.loadMore} disabled={loadingMore} onClick={loadMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </button>
                : <p className={styles.endNote}>That is the end of the list.</p>}
            </>}

    {filtersOpen && <FilterSheet
      query={query}
      onClose={() => setFiltersOpen(false)}
      onApply={(draft) => { update(draft); setFiltersOpen(false); }}
    />}

    {notice && <div className={styles.toast} role="status">
      {notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} aria-hidden /></button>
    </div>}
  </section>;
}
