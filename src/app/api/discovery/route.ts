import { asUser, creationSummaryFromRow } from "@/lib/db";
import { parseDiscoveryQuery, type DiscoverySort } from "@/lib/discovery";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The discovery feed.
 *
 * One statement per page. Every metric it reports is a denormalised aggregate
 * already maintained by a trigger — saves in `like_count`, stories in
 * `chat_count`, replies in `message_count` — so a page of cards never fans out
 * into a count query per card, and the private rows behind those totals are
 * never read.
 *
 * The column list is the security boundary. Greetings, personality,
 * backstories, response directives, boundaries, example dialogue, cast
 * definitions, world links and import source material are not selected at all,
 * so there is nothing here to blank out for a visitor and nothing to leak by
 * forgetting to.
 *
 * Visibility is enforced three times over: `characters_select_own_or_published`
 * in the database, the `visibility='public'` predicate here, and the absence of
 * any code path that would add drafts or unlisted rows to this list.
 */

const orderings: Record<DiscoverySort, string> = {
  // Most saved, then most chatted. Both are real global totals; neither is a
  // synthesised score, so the tab label can be read literally.
  popular: "c.like_count DESC, c.chat_count DESC, c.published_at DESC NULLS LAST, c.id DESC",
  chatted: "c.chat_count DESC, c.message_count DESC, c.published_at DESC NULLS LAST, c.id DESC",
  new: "c.published_at DESC NULLS LAST, c.created_at DESC, c.id DESC",
  /*
   * Strictly chronological, and that is the product decision rather than a
   * simplification. Following answers "what have the creators I chose put out",
   * and any reordering — popularity, a score, a blend of recommended work —
   * turns an instruction the reader gave into a suggestion the platform made.
   * The id breaks ties so paging is stable across the boundary.
   */
  following: "c.published_at DESC NULLS LAST, c.id DESC",
};

/** A search term is data, never pattern syntax. */
function likePattern(term: string) {
  return `%${term.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const query = parseDiscoveryQuery(new URL(request.url).searchParams);

  const values: unknown[] = [account.id];
  /*
   * The Following feed is a JOIN, not a filter applied afterwards.
   *
   * The alternative — read every followed creator id into the browser, fetch
   * creations, and narrow them there — would download a page of somebody else's
   * work in order to throw most of it away, and would page incorrectly the
   * moment it did. `profile_follows_follower_idx` serves the follow side and
   * `characters_creator_published_idx` serves each creator's own timeline, so
   * this is an index nested loop over exactly the rows that qualify.
   *
   * Row level security on `profile_follows` only ever returns rows naming this
   * account, so a feed can never be scoped to somebody else's follows even if
   * this predicate were wrong.
   */
  const followingFeed = query.sort === "following";
  const joins = followingFeed
    ? "JOIN profile_follows fw ON fw.creator_user_id=c.user_id AND fw.follower_user_id=$1"
    : "";
  const where: string[] = [
    // Public and nothing else. Eligibility is deliberately this one column
    // plus the viewer's adult setting and their active filters: a creation is
    // never required to carry a world, a hashtag, a quick fact, a cast member,
    // a save or a rank in order to be discoverable, and every join below is a
    // LEFT JOIN precisely so an absent optional row cannot delete a valid
    // creation from the feed.
    "c.visibility='public'",
    // The viewer's own public creations belong here too. Excluding them made
    // a creator's feed silently disagree with what they had just published,
    // which is the opposite of the confirmation publishing should give.
    // Their card simply has no save control, which the grid already handles.
  ];

  // Adult content is opt-in, and the opt-in is a property of this request
  // only: it widens what a feed may return, never what an account is allowed
  // to see, and it is never persisted as a preference.
  if (!query.includeAdult) where.push("c.nsfw_enabled=false");

  if (query.types.length) {
    values.push(query.types);
    // Resolved rather than compared raw: a row written before creations
    // existed has an empty creation_type and only its ensemble flag to go on.
    where.push(`(CASE WHEN c.creation_type IN ('character','cast','scenario') THEN c.creation_type
                      WHEN c.profile_type='ensemble' THEN 'cast' ELSE 'character' END) = ANY($${values.length}::text[])`);
  }

  if (query.tags.length) {
    // The overlap narrows through the gin index; the per-tag tests then make
    // the filter conjunctive, so two tags mean "both" rather than "either".
    values.push(query.tags);
    where.push(`c.tags && $${values.length}::text[]`);
    for (const tag of query.tags) {
      values.push(tag);
      where.push(`$${values.length} = ANY(c.tags)`);
    }
  }

  // Hashtags are matched exactly and only against hashtags: "#mha" is a
  // creator's vocabulary lookup, not a substring search across titles.
  if (query.hashtag) {
    values.push([query.hashtag]);
    where.push(`c.hashtags && $${values.length}::text[]`);
  }

  if (query.search) {
    values.push(likePattern(query.search));
    const term = `$${values.length}`;
    where.push(`(c.title ILIKE ${term} OR c.name ILIKE ${term} OR c.tagline ILIKE ${term} OR c.description ILIKE ${term}
      OR c.tags::text ILIKE ${term} OR c.hashtags::text ILIKE ${term}
      OR COALESCE(p.username,'') ILIKE ${term} OR COALESCE(p.display_name,'') ILIKE ${term})`);
  }

  // One row beyond the page, so "is there more" costs nothing and no COUNT(*)
  // over the whole public table is needed to answer it.
  values.push(query.limit + 1);
  const limitParam = `$${values.length}`;
  values.push(query.offset);
  const offsetParam = `$${values.length}`;

  const page = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
         c.tags,c.hashtags,c.nsfw_enabled,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
         (mine.character_id IS NOT NULL) saved_by_viewer
       FROM characters c
       ${joins}
       LEFT JOIN profiles p ON p.id=c.user_id
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderings[query.sort]}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    /*
     * How many creators this account follows, when — and only when — the feed
     * is the Following one.
     *
     * It is what separates the two empty states, which are different problems
     * with different answers: "you do not follow anybody yet" sends somebody to
     * Discovery, and "nobody you follow has published anything" tells them
     * nothing is wrong and there is nothing to do. One indexed count over the
     * viewer's own rows, and not read at all on the other three feeds.
     */
    const following = followingFeed
      ? Number((await client.query(
        "SELECT count(*)::int count FROM profile_follows WHERE follower_user_id=$1", [account.id],
      )).rows[0]?.count || 0)
      : null;
    return { rows: result.rows, following };
  });

  const hasMore = page.rows.length > query.limit;
  const rows = hasMore ? page.rows.slice(0, query.limit) : page.rows;
  return Response.json({
    creations: rows.map((row) => creationSummaryFromRow(row, account.id)),
    hasMore,
    nextOffset: query.offset + rows.length,
    // Null on every feed but Following, where it decides the empty state.
    followingCreators: page.following,
  });
}
