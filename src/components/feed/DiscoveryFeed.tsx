"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Compass, Menu, Search, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { creationTypeLabels } from "@/lib/creation";
import {
  activeFilterCount, discoveryPageSize, discoverySearchParams, discoverySortHints,
  discoverySortLabels, discoverySorts, isFilteredQuery, parseDiscoveryQuery, parseSearchTerm,
  type DiscoveryQuery, type DiscoverySort,
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

type Page = { creations: CreationSummary[]; hasMore: boolean; nextOffset: number };
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

  const scrollerRef = useRef<HTMLElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const restoredRef = useRef<Restorable | null>(null);
  const snapshotRef = useRef<Restorable | null>(null);

  // Read the address bar once the component is in the browser, and pick up any
  // page that was left behind for this exact query.
  useEffect(() => {
    const initial = parseDiscoveryQuery(new URLSearchParams(window.location.search));
    restoredRef.current = readRestorable(queryKey(initial));
    setQuery(initial);
    setTerm(initial.hashtag ? `#${initial.hashtag}` : initial.search);
    setReady(true);
  }, []);

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
      <p className={styles.lede}>Characters, casts and scenario roleplay, published by their creators. Save anything you want to come back to.</p>
    </header>

    <div className={`${styles.controls} ${stuck ? styles.controlsStuck : ""}`}>
      <div className={styles.controlRow}>
        {onOpenMenu && <button type="button" className={styles.menuButton} aria-label="Open menu" onClick={onOpenMenu}><Menu size={18} /></button>}
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
          ? <div className={styles.grid}><FeedState
              icon={<Search size={26} />}
              title={filtered ? "Nothing matches that yet" : "No published creations yet"}
              description={filtered
                ? "Try fewer filters, a different ordering, or a broader search term."
                : "When creators publish a character, cast or scenario it appears here. Your own creations live in your library."}
              action={filtered ? { label: "Clear filters", onClick: clearEverything } : undefined}
            /></div>
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
      {notice}<button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
    </div>}
  </section>;
}
