import { creationTypes, type CreationType } from "./types";
import { canonicalTag, normalizeHashtag } from "./tags";

/**
 * The discovery query contract.
 *
 * Shared by the feed component and the route so the URL, the fetch and the SQL
 * can never disagree about what a filter means. Everything here is derived
 * from data the product already stores; there is deliberately no personalised
 * mode, because there is no personalisation layer to back one.
 */

/**
 * Feed orderings.
 *
 * Each is a plain ordering over a real aggregate column, not a synthesised
 * score, so the label can be taken literally:
 *
 *   popular  — most saved, ties broken by chats
 *   chatted  — most chats started, ties broken by messages exchanged
 *   new      — most recently published
 *
 * There is no "For You". Every account receives the same rows for the same
 * query, and calling that personalised would be a lie.
 */
export const discoverySorts = ["popular", "chatted", "new"] as const;
export type DiscoverySort = typeof discoverySorts[number];

export const discoverySortLabels: Record<DiscoverySort, string> = {
  popular: "Popular",
  chatted: "Most chatted",
  new: "New",
};

export const discoverySortHints: Record<DiscoverySort, string> = {
  popular: "The most saved creations on Afterglow.",
  chatted: "Where the most stories have been started.",
  new: "The most recently published creations.",
};

export const defaultDiscoverySort: DiscoverySort = "popular";

/** One screen of cards. Large enough to fill a desktop grid, small enough for a phone. */
export const discoveryPageSize = 24;

export type DiscoveryQuery = {
  sort: DiscoverySort;
  /** Free text. Empty when the search box is empty or holds a hashtag. */
  search: string;
  /**
   * A creator hashtag, without the "#". Set only when the search term was
   * written as one, so "#mha" looks up the hashtag rather than searching for
   * the letters m-h-a inside titles.
   */
  hashtag: string;
  /** Platform taxonomy tags. Narrowing: a creation must carry all of them. */
  tags: string[];
  /** Authoring structures to include. Empty means all of them. */
  types: CreationType[];
  hideAdult: boolean;
  offset: number;
  limit: number;
};

export const emptyDiscoveryQuery: DiscoveryQuery = {
  sort: defaultDiscoverySort, search: "", hashtag: "", tags: [], types: [], hideAdult: false, offset: 0, limit: discoveryPageSize,
};

/**
 * Splits what somebody typed into the two search systems.
 *
 * A term beginning with "#" is a creator hashtag lookup; anything else is free
 * text. The two never merge: a hashtag search does not also match titles, and
 * a text search does not silently become a tag filter.
 */
export function parseSearchTerm(raw: string): { search: string; hashtag: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) {
    const hashtag = normalizeHashtag(trimmed);
    return hashtag ? { search: "", hashtag } : { search: "", hashtag: "" };
  }
  return { search: trimmed.slice(0, 120), hashtag: "" };
}

function readList(params: URLSearchParams, key: string) {
  return params.getAll(key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

/** Reads a query from a URL, clamping everything a caller could exaggerate. */
export function parseDiscoveryQuery(params: URLSearchParams): DiscoveryQuery {
  const sort = discoverySorts.find((value) => value === params.get("sort")) ?? defaultDiscoverySort;
  const { search, hashtag } = parseSearchTerm(params.get("q") ?? "");
  const tags = Array.from(new Set(readList(params, "tags").map(canonicalTag))).slice(0, 8);
  const types = Array.from(new Set(readList(params, "type").filter((value): value is CreationType =>
    (creationTypes as readonly string[]).includes(value))));
  const offset = Math.min(Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0), 5000);
  const limit = Math.min(Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || discoveryPageSize), 48);
  return { sort, search, hashtag, tags, types, hideAdult: params.get("adult") === "hide", offset, limit };
}

/**
 * The inverse, used both for the address bar and for the fetch. Defaults are
 * omitted so an untouched feed keeps a clean URL.
 */
export function discoverySearchParams(query: Partial<DiscoveryQuery> & { term?: string }) {
  const params = new URLSearchParams();
  if (query.sort && query.sort !== defaultDiscoverySort) params.set("sort", query.sort);
  const term = query.term ?? (query.hashtag ? `#${query.hashtag}` : query.search ?? "");
  if (term.trim()) params.set("q", term.trim());
  if (query.tags?.length) params.set("tags", query.tags.join(","));
  if (query.types?.length) params.set("type", query.types.join(","));
  if (query.hideAdult) params.set("adult", "hide");
  if (query.offset) params.set("offset", String(query.offset));
  if (query.limit && query.limit !== discoveryPageSize) params.set("limit", String(query.limit));
  return params;
}

/** True when anything beyond the ordering is narrowing the feed. */
export function isFilteredQuery(query: Pick<DiscoveryQuery, "search" | "hashtag" | "tags" | "types" | "hideAdult">) {
  return Boolean(query.search || query.hashtag || query.tags.length || query.types.length || query.hideAdult);
}

/** How many filter chips the filter button should advertise. */
export function activeFilterCount(query: Pick<DiscoveryQuery, "tags" | "types" | "hideAdult">) {
  return query.tags.length + query.types.length + (query.hideAdult ? 1 : 0);
}
