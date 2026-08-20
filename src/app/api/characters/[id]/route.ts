import { asUser, characterFromRow } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

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
      `UPDATE characters SET name=$1,profile_type=$2,tagline='',avatar_url=$3,avatar_path=$4,accent=$5,backstory=$6,cast_members=$7::jsonb,lorebook='',personality=$8,scenario=$9,greeting=$10,alternate_greetings=$11::jsonb,example_dialogue=$12,response_directive=$13,boundaries=$14,source_material=$15,nsfw_enabled=$16,visibility=$17,
         published_at=CASE WHEN $17='public' AND published_at IS NULL THEN now() WHEN $17<>'public' THEN NULL ELSE published_at END,
         updated_at=now()
       WHERE id=$18 AND user_id=$19 RETURNING *`,
      [c.name,c.profileType,c.avatarUrl,c.avatarPath,c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,c.visibility,id,account.id],
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
