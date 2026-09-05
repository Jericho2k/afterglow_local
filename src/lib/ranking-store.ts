import { artPresentation, type ArtPresentation } from "./art-presentation";
import type { PoolClient } from "pg";
import { asUser } from "./db";
import { rankingBoardSize, rankingCategories, type CreationRank } from "./rankings";
import type { RefreshStatus } from "./creator-stats";

/**
 * Rankings: the database side.
 *
 * Split from `rankings.ts` because the rule for which badge a creation shows is
 * needed in the browser and this is not: a client bundle that imported the
 * refresh would drag the PostgreSQL driver in with it.
 */

/**
 * How stale a board may be.
 *
 * Ten minutes, matching the creator standings. A board of the most-read
 * creations on the platform does not meaningfully reorder between one page view
 * and the next, and pretending otherwise would mean re-ordering every public
 * creation to draw the same list again.
 */
const maxAgeMs = Number(process.env.CREATION_RANKINGS_MAX_AGE_MS || 10 * 60_000);

/**
 * Rebuilds the boards when they have gone stale, at most once per window.
 *
 * The same single atomic UPDATE `refreshCreatorStatsIfStale` uses: whichever
 * request wins it does the work, every other concurrent reader gets `fresh` and
 * serves the boards that are already there. No lock, no queue, no worker.
 *
 * Runs in a TRANSACTION OF ITS OWN, and never throws. PostgreSQL aborts a
 * transaction after any failed statement, so a rebuild that failed inside the
 * page's transaction would take the page down with it — on a deployment that
 * has not applied 0022, every rankings request would 500 rather than showing an
 * empty board. Isolating it is what makes "never throws" true rather than
 * merely intended.
 */
export async function refreshCreationRankingsIfStale(userId: string, now = Date.now()): Promise<RefreshStatus> {
  try {
    return await asUser(userId, async (client) => {
      const claimed = await client.query(
        "UPDATE creation_rankings_refresh SET refreshed_at=now() WHERE id=true AND refreshed_at < $1 RETURNING refreshed_at",
        [new Date(now - maxAgeMs).toISOString()],
      );
      if (!claimed.rowCount) return "fresh";
      await client.query("SELECT public.refresh_creation_rankings($1::text[],$2)", [rankingCategories, rankingBoardSize]);
      return "refreshed";
    });
  } catch {
    return "failed";
  }
}

/**
 * Every board one creation appears on.
 *
 * At most one row per genre it carries plus the overall row, read through
 * `creation_rankings_creation_idx`. Returns an empty list rather than throwing
 * on a deployment where the table does not exist yet: a creation page without a
 * rank badge is a page, and one that fails to load is not.
 */
export async function creationRanks(client: PoolClient, characterId: string): Promise<CreationRank[]> {
  try {
    const result = await client.query(
      "SELECT category,rank,rank_total FROM creation_rankings WHERE character_id=$1 ORDER BY rank ASC",
      [characterId],
    );
    return result.rows.map((row) => ({
      category: String(row.category || ""),
      rank: Number(row.rank),
      rankTotal: Number(row.rank_total || 0),
    }));
  } catch {
    return [];
  }
}


export type RankedCreatorRow = {
  rank: number;
  rankTotal: number;
  id: string;
  username: string;
  displayName: string;
  avatarPath: string;
  profileBorder: string;
  followers: number;
  messages: number;
  creations: number;
  worlds: number;
  saves: number;
  viewerFollows: boolean;
  topCreation: { id: string; title: string; avatarPath: string; avatarUrl: string; accent: string; messages: number; artPresentation: ArtPresentation } | null;
};

/**
 * A page of the creators board, in one statement.
 *
 * The lateral is what makes a row worth tapping rather than merely reading: it
 * is the creator's own most-read creation, which is both the artwork for their
 * row and the honest answer to "what are they known for". It costs one index
 * lookup per row of a page — `characters_creator_popular_idx` is
 * `(user_id, user_message_count DESC, …) WHERE visibility='public'` — inside
 * the same statement, so it is not a round trip per creator.
 *
 * `follows` resolves the viewer's own row and nobody else's; row level security
 * on `profile_follows` guarantees that independently of the predicate.
 *
 * A function rather than inline SQL in the route because it is the half of the
 * board that pg-mem cannot evaluate — it does not support a lateral correlated
 * to an outer alias — so this is what the real-PostgreSQL suite calls to check
 * the query the route actually runs, instead of a second copy of it.
 */
export async function rankedCreators(
  client: PoolClient,
  viewerId: string,
  options: { limit: number; offset: number },
): Promise<RankedCreatorRow[]> {
  const result = await client.query(
    `SELECT cs.rank,cs.rank_total,cs.user_messages,cs.followers,cs.published_creations,cs.published_worlds,cs.saves,
       p.id,p.username,p.display_name,p.avatar_path,p.profile_border,
       (f.creator_user_id IS NOT NULL) viewer_follows,
       top.id top_id,top.title top_title,top.name top_name,top.avatar_path top_avatar_path,
       top.avatar_url top_avatar_url,top.accent top_accent,top.art_presentation top_art_presentation,top.user_message_count top_messages
     FROM creator_stats cs
     JOIN profiles p ON p.id=cs.user_id AND p.username IS NOT NULL
     LEFT JOIN profile_follows f ON f.creator_user_id=cs.user_id AND f.follower_user_id=$1
     LEFT JOIN LATERAL (
       SELECT id,title,name,avatar_path,avatar_url,accent,art_presentation,user_message_count
       FROM characters
       WHERE user_id=cs.user_id AND visibility='public'
       ORDER BY user_message_count DESC, like_count DESC, id
       LIMIT 1
     ) top ON true
     WHERE cs.rank IS NOT NULL
     ORDER BY cs.rank ASC
     LIMIT $2 OFFSET $3`,
    [viewerId, options.limit, options.offset],
  );
  return result.rows.map((row) => ({
    rank: Number(row.rank),
    rankTotal: Number(row.rank_total || 0),
    id: String(row.id),
    username: String(row.username || ""),
    displayName: String(row.display_name || ""),
    avatarPath: String(row.avatar_path || ""),
    profileBorder: String(row.profile_border || "default"),
    followers: Number(row.followers || 0),
    messages: Number(row.user_messages || 0),
    creations: Number(row.published_creations || 0),
    worlds: Number(row.published_worlds || 0),
    saves: Number(row.saves || 0),
    viewerFollows: Boolean(row.viewer_follows),
    topCreation: row.top_id
      ? {
        id: String(row.top_id),
        title: String(row.top_title || row.top_name || "Untitled"),
        avatarPath: String(row.top_avatar_path || ""),
        avatarUrl: String(row.top_avatar_url || ""),
        accent: String(row.top_accent || "#e879a9"),
        artPresentation: artPresentation(row.top_art_presentation),
        messages: Number(row.top_messages || 0),
      }
      : null,
  }));
}
