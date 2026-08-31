import type { PoolClient } from "pg";
import { worldSummaryFromRow } from "./db";
import type { WorldSummary } from "./types";

/**
 * The worlds a STORY is written with.
 *
 * Afterglow has two world relations now, and keeping them apart is the whole
 * of this module:
 *
 *   `character_worlds` — the creator's DEFAULTS. Edited in the studio, shown on
 *   the creation page, and copied into a story when the story begins. Nothing
 *   in a chat writes to it, which is the bug this replaces: the chat's picker
 *   used to save through `PATCH /api/characters/{id}`, so attaching a world in
 *   one conversation attached it to the Creation and therefore to everybody.
 *
 *   `conversation_worlds` — what THIS story is actually written with. Private
 *   to the conversation's owner, independent of the Creation from the moment
 *   the story starts, and the only thing the writer prompt reads.
 *
 * Two rules make the separation hold, and both live here rather than in a
 * route:
 *
 *   A STORY'S SET IS SNAPSHOT, NOT INHERITED. It is copied once at creation.
 *   A creator adding a world to their Creation next month changes what NEW
 *   stories start with and changes nothing about a story already in progress —
 *   which is the difference between authoring a template and editing somebody's
 *   ongoing fiction underneath them.
 *
 *   READABILITY IS CHECKED TWICE. Once when a world is attached, and again
 *   every time the set is read for a prompt. The second check is what makes a
 *   world going private actually take effect: the link stays, the lore stops.
 */

/** Every column a world card needs, and never `content`. */
const summaryColumns = `w.id,w.user_id,w.name,w.description,w.cover_path,w.cover_url,w.visibility,w.save_count,w.created_at,w.updated_at`;

/** Whether this account may put this world into one of its own prompts. */
const readable = `(w.user_id=$1 OR w.visibility IN ('public','unlisted'))`;

/**
 * The Creation's defaults, filtered to what this account may actually use.
 *
 * A creator gets their own worlds, private ones included, exactly as before. A
 * visitor to a published creation gets the creator's PUBLIC worlds and never
 * their private ones — the creation page already shows those as locked cards
 * with a name and a cover and no lore, and this is the same boundary applied
 * to the prompt.
 */
export async function readableDefaultWorldIds(client: PoolClient, userId: string, characterId: string) {
  const result = await client.query(
    `SELECT w.id FROM worlds w
     JOIN character_worlds cw ON cw.world_id=w.id
     WHERE cw.character_id=$2 AND ${readable}
     ORDER BY w.updated_at DESC`,
    [userId, characterId],
  );
  return result.rows.map((row) => String(row.id));
}

/**
 * Gives a new story its starting set.
 *
 * Idempotent, and it marks the conversation initialized whether or not any
 * world was copied. That flag is what distinguishes "this story has no worlds
 * because its creator removed them" from "this story predates conversation
 * worlds": without it, detaching the last world from a story would be undone
 * by the next read.
 */
export async function initializeConversationWorlds(
  client: PoolClient,
  userId: string,
  conversationId: string,
  characterId: string,
) {
  const worldIds = await readableDefaultWorldIds(client, userId, characterId);
  for (const worldId of worldIds) {
    await attachConversationWorld(client, userId, conversationId, worldId);
  }
  await client.query(
    "UPDATE conversations SET worlds_initialized=true WHERE id=$1 AND user_id=$2",
    [conversationId, userId],
  );
  return worldIds;
}

/**
 * Initializes a conversation that has never been given a set.
 *
 * The migration backfills every conversation that existed when it ran. This
 * covers the two cases a migration cannot: a database where 0019 has not been
 * applied yet, and a conversation written by a code path that predates it.
 * Returns true when it actually did something.
 */
export async function ensureConversationWorlds(client: PoolClient, userId: string, conversation: Record<string, unknown>) {
  if (conversation.worlds_initialized) return false;
  await initializeConversationWorlds(client, userId, String(conversation.id), String(conversation.character_id));
  return true;
}

/**
 * The worlds this story is written with, as full records for the prompt.
 *
 * The readability predicate is applied HERE and not only at attach time, so a
 * world whose creator made it private after it was attached stops contributing
 * lore immediately, without anything having to notice and clean up the link.
 */
export async function conversationWorldRecords(client: PoolClient, userId: string, conversationId: string) {
  const result = await client.query(
    /*
     * ORDERED BY WHEN THE WORLD WAS ATTACHED, NOT BY WHEN IT WAS LAST EDITED.
     *
     * This ordering is not presentation — it decides the byte order of the
     * LOREBOOK section, which sits near the top of the stable half of the
     * prompt. Everything after the first byte that moves is billed as fresh
     * input, so an unstable order here is expensive in a way an unstable order
     * in a list of cards is not.
     *
     * `updated_at DESC` was unstable in two separate ways. Two worlds attached
     * together share a timestamp to the microsecond, and Postgres is free to
     * return tied rows in either order on any given query — so the same
     * conversation could serialise its lore two different ways on consecutive
     * turns and pay for the whole prompt twice. And editing ANY attached world
     * moved it to the front, displacing worlds whose text had not changed at
     * all.
     *
     * Attachment time with the world id as a tiebreaker is a TOTAL order over
     * immutable columns, so it cannot tie and cannot drift. It changes nothing
     * a reader or a writer can perceive: the same worlds, the same lore, the
     * same section — only a fixed sequence instead of an incidental one. The
     * card queries above and below keep recency ordering, which is the right
     * answer for a list somebody is looking at.
     */
    `SELECT w.* FROM worlds w
     JOIN conversation_worlds cw ON cw.world_id=w.id
     WHERE cw.conversation_id=$2 AND cw.user_id=$1 AND ${readable}
     ORDER BY cw.created_at ASC, w.id ASC`,
    [userId, conversationId],
  );
  return result.rows;
}

/** The same set as cards: identity, cover and one line. Never lore. */
export async function conversationWorldSummaries(client: PoolClient, userId: string, conversationId: string): Promise<WorldSummary[]> {
  const result = await client.query(
    `SELECT ${summaryColumns},
       (mine.world_id IS NOT NULL) saved_by_viewer,
       p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path
     FROM worlds w
     JOIN conversation_worlds cw ON cw.world_id=w.id
     LEFT JOIN world_saves mine ON mine.world_id=w.id AND mine.user_id=$1
     LEFT JOIN profiles p ON p.id=w.user_id
     WHERE cw.conversation_id=$2 AND cw.user_id=$1 AND ${readable}
     ORDER BY w.updated_at DESC`,
    [userId, conversationId],
  );
  return result.rows.map((row) => worldSummaryFromRow(row, userId));
}

/**
 * Attaches one world to one story.
 *
 * The `WHERE EXISTS` is the load-bearing part: an id naming a world this
 * account may not read inserts nothing rather than inserting a link that later
 * reads have to remember to filter. Returns whether a link now exists.
 */
export async function attachConversationWorld(client: PoolClient, userId: string, conversationId: string, worldId: string) {
  const result = await client.query(
    `INSERT INTO conversation_worlds (conversation_id,world_id,user_id)
     SELECT $1,$2,$3
     WHERE EXISTS (SELECT 1 FROM conversations v WHERE v.id=$1 AND v.user_id=$3)
       AND EXISTS (SELECT 1 FROM worlds w WHERE w.id=$2 AND (w.user_id=$3 OR w.visibility IN ('public','unlisted')))
     ON CONFLICT (conversation_id,world_id) DO NOTHING`,
    [conversationId, worldId, userId],
  );
  if (result.rowCount) return true;
  const existing = await client.query(
    "SELECT 1 FROM conversation_worlds WHERE conversation_id=$1 AND world_id=$2 AND user_id=$3",
    [conversationId, worldId, userId],
  );
  return Boolean(existing.rowCount);
}

export async function detachConversationWorld(client: PoolClient, userId: string, conversationId: string, worldId: string) {
  const result = await client.query(
    "DELETE FROM conversation_worlds WHERE conversation_id=$1 AND world_id=$2 AND user_id=$3",
    [conversationId, worldId, userId],
  );
  return Boolean(result.rowCount);
}

/**
 * Replaces a story's whole set.
 *
 * Written as a diff rather than a delete-and-reinsert so `created_at` survives
 * on a world that was already attached, and so a request naming an unreadable
 * world removes nothing it should not.
 */
export async function setConversationWorlds(client: PoolClient, userId: string, conversationId: string, worldIds: string[]) {
  const wanted = [...new Set(worldIds)];
  const current = await client.query(
    "SELECT world_id FROM conversation_worlds WHERE conversation_id=$1 AND user_id=$2",
    [conversationId, userId],
  );
  const have = new Set(current.rows.map((row) => String(row.world_id)));
  for (const worldId of wanted) {
    if (!have.has(worldId)) await attachConversationWorld(client, userId, conversationId, worldId);
  }
  for (const worldId of have) {
    if (!wanted.includes(worldId)) await detachConversationWorld(client, userId, conversationId, worldId);
  }
  // Explicitly emptying a story's set is a decision, and it has to survive.
  await client.query("UPDATE conversations SET worlds_initialized=true WHERE id=$1 AND user_id=$2", [conversationId, userId]);
}

/**
 * A branch inherits the world set of the story it came from.
 *
 * Not the Creation's defaults: a branch is a continuation of THIS story, and
 * the canon it was being written with is part of what it continues. Copied at
 * the moment of branching, and independent from that moment on, exactly like
 * its memories and its scene state.
 */
export async function copyConversationWorldsForBranch(
  client: PoolClient,
  input: { userId: string; sourceConversationId: string; conversationId: string },
) {
  await client.query(
    `INSERT INTO conversation_worlds (conversation_id,world_id,user_id)
     SELECT $1,cw.world_id,$3 FROM conversation_worlds cw
     WHERE cw.conversation_id=$2 AND cw.user_id=$3
     ON CONFLICT (conversation_id,world_id) DO NOTHING`,
    [input.conversationId, input.sourceConversationId, input.userId],
  );
  await client.query("UPDATE conversations SET worlds_initialized=true WHERE id=$1 AND user_id=$2", [input.conversationId, input.userId]);
}
