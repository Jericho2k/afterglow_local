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
  const where: string[] = [
    "c.visibility='public'",
    // Discovery is other people's work; the caller's own creations live in
    // their sidebar and in Chats, exactly as they did before this feed.
    "c.user_id<>$1",
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

  const rows = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
         c.tags,c.hashtags,c.nsfw_enabled,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path,
         (mine.character_id IS NOT NULL) saved_by_viewer
       FROM characters c
       LEFT JOIN profiles p ON p.id=c.user_id AND p.username IS NOT NULL
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$1
       WHERE ${where.join(" AND ")}
       ORDER BY ${orderings[query.sort]}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      values,
    );
    return result.rows;
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  return Response.json({
    creations: page.map((row) => creationSummaryFromRow(row, account.id)),
    hasMore,
    nextOffset: query.offset + page.length,
  });
}
