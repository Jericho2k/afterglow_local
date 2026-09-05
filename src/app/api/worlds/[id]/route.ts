import { asUser, creationSummaryFromRow, worldFromRow } from "@/lib/db";
import { maxLoreBlockText, richFieldPayload } from "@/lib/rich-content";
import { worldSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * A world's own page.
 *
 * A world is readable by whoever its creator published it to, not only by its
 * owner, and it lists the creations that use it — which is what makes the
 * relationship "one world, many creations" rather than "a lorebook inside one
 * character". Those creations are the same lean summaries the discovery feed
 * renders, so nothing hidden is selected for them either.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  const detail = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT w.*,(mine.world_id IS NOT NULL) saved_by_viewer,
         p.id creator_id,p.username creator_username,p.display_name creator_display_name,p.avatar_path creator_avatar_path
       FROM worlds w
       LEFT JOIN world_saves mine ON mine.world_id=w.id AND mine.user_id=$2
       LEFT JOIN profiles p ON p.id=w.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       WHERE w.id=$1 AND (w.user_id=$2 OR w.visibility IN ('public','unlisted'))`,
      [id, account.id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const owner = String(row.user_id ?? "") === account.id;
    // Public creations, plus the viewer's own whatever their visibility. A
    // draft belonging to somebody else never appears, so the association list
    // cannot be used to learn that an unpublished creation exists.
    const creations = await client.query(
      `SELECT c.id,c.user_id,c.name,c.title,c.creation_type,c.profile_type,c.tagline,c.avatar_url,c.avatar_path,c.accent,
         c.tags,c.hashtags,c.content_mode,c.nsfw_enabled,c.banner_path,c.banner_url,c.art_presentation,c.message_count,c.chat_count,c.like_count,c.published_at,c.created_at,
         pc.id creator_id,pc.username creator_username,pc.display_name creator_display_name,pc.avatar_path creator_avatar_path,
         (saved.character_id IS NOT NULL) saved_by_viewer
       FROM characters c
       JOIN character_worlds cw ON cw.character_id=c.id
       LEFT JOIN profiles pc ON pc.id=c.user_id AND pc.username IS NOT NULL
       LEFT JOIN character_likes saved ON saved.character_id=c.id AND saved.user_id=$2
       WHERE cw.world_id=$1 AND (c.user_id=$2 OR c.visibility='public')
       ORDER BY c.like_count DESC, c.updated_at DESC LIMIT 24`,
      [id, account.id],
    );
    return {
      world: worldFromRow(row, account.id),
      owner,
      creations: creations.rows.map((creation) => creationSummaryFromRow(creation, account.id)),
    };
  });

  if (!detail) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json(detail);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const value = parsed.data;
  const lore = richFieldPayload(value.contentRich.length ? value.contentRich : [{ type: "text", text: value.content }], maxLoreBlockText);
  // user_id in the predicate means a request naming somebody else's world
  // updates nothing rather than being silently accepted.
  const result = await asUser(account.id, (client) => client.query(
    `UPDATE worlds SET name=$1,description=$2,content=$3,content_rich=$9::jsonb,visibility=$4,cover_path=$7,cover_url=$8,updated_at=now()
     WHERE id=$5 AND user_id=$6 RETURNING *`,
    [value.name,value.description,lore.text || value.content,value.visibility,id,account.id,value.coverPath,value.coverUrl,JSON.stringify(lore.rich)],
  ));
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ world: worldFromRow(result.rows[0], account.id) });
}

/**
 * Deleting a world.
 *
 * A world is reusable, so deleting one is not deleting the creations that use
 * it: the `character_worlds` rows cascade and those creations simply stop
 * having a world attached. Nothing else about them changes, and no creation is
 * ever removed as a side effect. The caller is told how many will be affected
 * before it happens — that count is what the confirmation is built from.
 */
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const outcome = await asUser(account.id, async (client) => {
    const attached = await client.query(
      "SELECT count(*)::int count FROM character_worlds cw JOIN characters c ON c.id=cw.character_id WHERE cw.world_id=$1 AND c.user_id=$2",
      [id, account.id],
    );
    const result = await client.query("DELETE FROM worlds WHERE id=$1 AND user_id=$2", [id, account.id]);
    return { deleted: result.rowCount ?? 0, detached: Number(attached.rows[0]?.count ?? 0) };
  });
  if (!outcome.deleted) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ ok: true, detachedCreations: outcome.detached });
}
