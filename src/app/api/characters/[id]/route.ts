import { asUser, characterFromRow, worldFromRow } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  const detail = await asUser(account.id, async (client) => {
    const result = await client.query(
      `SELECT c.*,p.id creator_id,p.username creator_username,p.display_name creator_display_name,
         p.avatar_path creator_avatar_path,(mine.character_id IS NOT NULL) liked_by_viewer
       FROM characters c
       LEFT JOIN profiles p ON p.id=c.user_id AND (p.id=$2 OR p.username IS NOT NULL)
       LEFT JOIN character_likes mine ON mine.character_id=c.id AND mine.user_id=$2
       WHERE c.id=$1 AND (c.user_id=$2 OR c.visibility IN ('public','unlisted'))`,
      [id, account.id],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const owner = String(row.user_id) === account.id;
    const worlds = await client.query(
      `SELECT w.* FROM worlds w
       JOIN character_worlds cw ON cw.world_id=w.id
       WHERE cw.character_id=$1 AND (w.user_id=$2 OR w.visibility IN ('public','unlisted'))
       ORDER BY w.updated_at DESC`,
      [id, account.id],
    );
    // This is deliberately viewer-scoped. A public character page must never
    // expose another account's private stories, even as an aggregate.
    const messages = await client.query(
      `SELECT COUNT(DISTINCT COALESCE(m.authored_event_id,m.id))::int count
       FROM messages m JOIN conversations v ON v.id=m.conversation_id
       WHERE m.user_id=$1 AND v.user_id=$1 AND v.character_id=$2 AND m.role='user'
         AND m.generation_started_at IS NOT NULL`,
      [account.id, id],
    );
    const worldIds = worlds.rows.map((world) => String(world.id));
    return {
      character: characterFromRow({ ...row, world_ids: worldIds }, account.id),
      worlds: worlds.rows.map(worldFromRow),
      viewerMessageCount: Number(messages.rows[0]?.count || 0),
      owner,
    };
  });

  if (!detail) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json(detail);
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;

  const row = await asUser(account.id, async (client) => {
    // user_id in the predicate means a request naming somebody else's
    // character updates nothing rather than being silently accepted.
    const result = await client.query(
      `UPDATE characters SET name=$1,profile_type=$2,tagline=$3,avatar_url=$4,avatar_path=$5,accent=$6,backstory=$7,cast_members=$8::jsonb,lorebook='',personality=$9,scenario=$10,greeting=$11,alternate_greetings=$12::jsonb,example_dialogue=$13,response_directive=$14,boundaries=$15,source_material=$16,nsfw_enabled=$17,visibility=$18,
         published_at=CASE WHEN $18='public' AND published_at IS NULL THEN now() WHEN $18<>'public' THEN NULL ELSE published_at END,
         updated_at=now()
       WHERE id=$19 AND user_id=$20 RETURNING *`,
      [c.name,c.profileType,c.tagline,c.avatarUrl,c.avatarPath,c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,c.visibility,id,account.id],
    );
    if (!result.rowCount) return null;
    await client.query("DELETE FROM character_worlds WHERE character_id=$1", [id]);
    for (const worldId of c.worldIds) {
      await client.query(
        "INSERT INTO character_worlds (character_id,world_id) SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM worlds WHERE id=$2 AND user_id=$3) ON CONFLICT DO NOTHING",
        [id,worldId,account.id],
      );
    }
    const links = await client.query("SELECT world_id FROM character_worlds WHERE character_id=$1", [id]);
    return { row: result.rows[0], worldIds: links.rows.map((link) => String(link.world_id)) };
  });

  if (!row) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ character: characterFromRow({ ...row.row, world_ids: row.worldIds }, account.id) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;

  try {
    const deleted = await asUser(account.id, (client) => client.query("DELETE FROM characters WHERE id=$1 AND user_id=$2", [id, account.id]));
    if (!deleted.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    // The database refuses to cascade a published character's deletion into
    // other accounts' private chats. Surface that as a conflict to resolve
    // rather than a server error.
    if (error instanceof Error && error.message.includes("character_in_use_by_other_accounts")) {
      return Response.json(
        { error: "Other accounts are chatting with this character. Set it back to private instead of deleting it." },
        { status: 409 },
      );
    }
    throw error;
  }
}
