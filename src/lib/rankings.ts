import { platformTagCategories } from "./tags";

/**
 * Rankings: the shared contract.
 *
 * Deliberately free of any database import, because a creation page renders
 * `bestRankBadge`'s answer in the browser and a module that reaches `pg` cannot
 * be in that bundle. The reads and the rebuild live beside it in
 * ranking-store.ts, which is server-only.
 *
 * Two boards, one metric, and one rule about which of them a page is allowed to
 * mention.
 *
 * THE METRIC is USER messages: turns a reader actually typed and sent into a
 * published creation. Not the model's replies, not the opening greeting, not a
 * regenerated alternative. `characters.message_count` counts all of those and
 * is roughly double; `characters.user_message_count` — defined once in
 * 0021_creator_profile_v2.sql and maintained by one trigger — is the number
 * that means "people are actually using this". Creator standing already uses
 * it, so a creation's rank and its creator's rank cannot disagree about what
 * they are counting.
 *
 * THE COST is paid once. A board is a global ordering, so answering "where does
 * this creation stand" from scratch means ordering every public creation on the
 * platform. That is precomputed into `creation_rankings` and refreshed on a
 * timer, exactly like `creator_stats`; nothing here aggregates raw messages on
 * a page view.
 */

/**
 * The categories a creation can be ranked within.
 *
 * The GENRE group of the platform taxonomy, and only that group. The other
 * groups answer different questions — who the creation is centred on, who the
 * reader plays as, the dynamic between them — and "the most-read Submissive
 * creations" is not a board anybody is looking for.
 *
 * Creator hashtags are not eligible and cannot be. They are freeform text by
 * design; a ranking category anybody can mint by typing it is a ranking nobody
 * can trust, and the two systems are kept apart everywhere else for exactly
 * this reason.
 *
 * Derived rather than restated, so a genre added to the taxonomy is a genre
 * that can be ranked without a second list needing to remember.
 */
export const rankingCategories: string[] =
  platformTagCategories.find((category) => category.id === "genre")?.tags ?? [];

const categoryLookup = new Map(rankingCategories.map((category) => [category.toLowerCase(), category]));

/** The canonical spelling of a category, or "" when it is not a board. */
export function rankingCategory(value: string | null | undefined) {
  return categoryLookup.get(String(value ?? "").trim().toLowerCase()) ?? "";
}

/** The board a query names: "" is Overall, anything else a genre. */
export function parseRankingCategory(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.toLowerCase() === "overall") return "";
  return rankingCategory(trimmed);
}

/**
 * How deep each board is stored.
 *
 * Ranking every public creation is cheap; WRITING the result is not — on a
 * platform of 120,000 creations the full boards are around 334,000 rows and
 * upserting them took 14.8 seconds, inside whichever reader's request happened
 * to win the refresh claim. Nothing needs that depth: the creation page only
 * mentions a rank of 100 or better, and nobody pages to the nine-hundredth
 * entry of a leaderboard. The stored figure for the size of the field is still
 * the true one, so a position remains "#5 of 12,480".
 */
export const rankingBoardSize = 1000;

export const overallBoardLabel = "Overall";

/** How a board is named in the interface. */
export function rankingCategoryLabel(category: string) {
  return category || overallBoardLabel;
}

export type CreationRank = {
  /** "" for the overall board. */
  category: string;
  rank: number;
  rankTotal: number;
};

/**
 * How impressive a rank has to be before a creation page mentions it.
 *
 * A badge everybody carries is a label. Below the hundredth position a rank
 * stops being an achievement and starts being a statistic, so the creation page
 * says nothing — the full standing is still on the rankings board and in the
 * creator's own profile, where somebody has gone looking for it.
 */
export const rankBadgeThreshold = 100;

/**
 * The one rank a creation page shows.
 *
 * A creation that is #147 overall, #5 in Drama, #19 in Romance and #73 in
 * Fantasy has one interesting fact about it, and it is "#5 in Drama". Printing
 * all four is how a page stops being read.
 *
 * The rule, in order:
 *
 *   1. Only ranks at or better than 100 are eligible at all.
 *   2. A CATEGORY rank beats the overall one. Being fifth in Drama says
 *      something about the work; being 147th out of everything says something
 *      about the size of the platform.
 *   3. Among categories, the best numerical rank wins.
 *   4. Ties break on the LARGER field first — fifth out of nine hundred is a
 *      better result than fifth out of twelve — and then on the category name,
 *      so the choice is total and the same input always produces the same
 *      badge.
 */
export function bestRankBadge(ranks: readonly CreationRank[]): CreationRank | null {
  const eligible = ranks.filter((entry) => entry.rank <= rankBadgeThreshold);
  if (!eligible.length) return null;
  const categorised = eligible.filter((entry) => entry.category);
  const pool = categorised.length ? categorised : eligible;
  return [...pool].sort((left, right) =>
    left.rank - right.rank
    || right.rankTotal - left.rankTotal
    || left.category.localeCompare(right.category),
  )[0] ?? null;
}

/** "#5 in Drama", or "#42 Overall" when the overall board is the only one. */
export function rankBadgeLabel(badge: CreationRank) {
  return badge.category ? `#${badge.rank} in ${badge.category}` : `#${badge.rank} Overall`;
}
