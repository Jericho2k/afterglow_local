import { asUser, creationSummaryFromRow } from "@/lib/db";
import { effectiveBorder } from "@/lib/cosmetics";
import { refreshCreatorStatsIfStale } from "@/lib/creator-stats";
import { parseRankingCategory, rankingBoardSize, rankingCategories } from "@/lib/rankings";
import { rankedCreators, refreshCreationRankingsIfStale } from "@/lib/ranking-store";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * Rankings.
 *
 * A DISCOVERY surface that happens to be ordered by a number, rather than an
 * analytics page that happens to list things. Every row it returns is a
 * complete card — artwork, title, creator, metrics, follow state — because the
 * point of the page is that somebody taps one of them, and a leaderboard whose
 * rows are only text is a table.
 *
 * Nothing is aggregated here. `creation_rankings` and `creator_stats` are
 * materialised and refreshed on a timer; this route reads a page of one of them
 * through an index. The two refreshes happen BEFORE the page's transaction
 * opens, in transactions of their own, for the reason spelled out in
 * `refreshCreatorStatsIfStale`: PostgreSQL aborts a transaction after a failed
 * statement, so a rebuild that failed inside the page's own transaction would
 * take the page down with it on any deployment that has not applied 0022.
 * Neither ever throws — a stale board is a page, and a failed one is not.
 */

const boards = ["creations", "creators"] as const;
type Board = typeof boards[number];

const pageSize = 25;

/** Columns a ranked creation card needs. Nothing hidden is selectable here. */
const creationColumns = `c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
  c.tags,c.hashtags,c.nsfw_enabled,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
  p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
  (mine.character_id IS NOT NULL) saved_by_viewer`;

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;
  const board: Board = boards.find((value) => value === params.get("board")) ?? "creations";
  const category = parseRankingCategory(params.get("category"));
  const limit = Math.min(Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || pageSize), 50);
  // Never past the end of a stored board; see `rankingBoardSize`.
  const offset = Math.min(Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0), rankingBoardSize);

  if (board === "creators") {
    await refreshCreatorStatsIfStale(account.id);
    const rows = await asUser(account.id, (client) => rankedCreators(client, account.id, { limit: limit + 1, offset }));
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return Response.json({
      board: "creators",
      hasMore,
      nextOffset: offset + page.length,
      total: Number(page[0]?.rankTotal || 0),
      creators: page.map((row) => ({
        rank: row.rank,
        rankTotal: row.rankTotal,
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        avatarPath: row.avatarPath,
        // The ring they have actually earned, decided from the same metrics
        // their profile uses — a stored choice they no longer qualify for
        // falls back rather than being honoured.
        border: effectiveBorder(row.profileBorder, {
          followers: row.followers, messages: row.messages,
          publishedCreations: row.creations, publishedWorlds: row.worlds,
          rank: row.rank,
        }, row.rankTotal),
        followers: row.followers,
        messages: row.messages,
        creations: row.creations,
        viewerFollows: row.viewerFollows,
        owner: row.id === account.id,
        // A thumbnail and a destination. No definition, no greeting.
        topCreation: row.topCreation,
      })),
    });
  }

  await refreshCreationRankingsIfStale(account.id);
  const payload = await asUser(account.id, async (client) => {
    /*
     * One board, read through `creation_rankings_board_idx`.
     *
     * The join onto `characters` requires the creation to still be public, so a
     * creation unpublished since the last rebuild drops out of the board
     * immediately rather than sitting at #7 until the timer comes round. The
     * ranking table itself is corrected on the next refresh.
     */
    const result = await client.query(
      `SELECT r.rank,r.rank_total,r.user_messages,${creationColumns}
       FROM creation_rankings r
       JOIN characters c ON c.id=r.character_id AND c.visibility='public'
       LEFT JOIN profiles p ON p.id=c.user_id AND p.username IS NOT NULL
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
       WHERE r.category=$2
       ORDER BY r.rank ASC
       LIMIT $3 OFFSET $4`,
      [account.id, category, limit + 1, offset],
    );
    return result.rows;
  });

  const hasMore = payload.length > limit;
  const rows = hasMore ? payload.slice(0, limit) : payload;
  return Response.json({
    board: "creations",
    category,
    categories: rankingCategories,
    hasMore,
    nextOffset: offset + rows.length,
    total: Number(rows[0]?.rank_total || 0),
    creations: rows.map((row) => ({
      rank: Number(row.rank),
      rankTotal: Number(row.rank_total || 0),
      /*
       * The board's own metric, named for what it is.
       *
       * `messageCount` on the card underneath is `message_count`, which counts
       * the model's replies and every regenerated alternative too. This is
       * `user_message_count`: turns a reader actually sent. Two numbers under
       * one word on one page would be a page that contradicts itself, so the
       * ranked row shows this one and says "messages sent".
       */
      userMessages: Number(row.user_messages || 0),
      creation: creationSummaryFromRow(row, account.id),
    })),
  });
}
