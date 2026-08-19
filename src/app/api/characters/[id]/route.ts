import { requireAuth } from "@/lib/auth";
import { characterFromRow, query, transaction } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;
  const row = await transaction(async (client) => {
    const result = await client.query(
      `UPDATE characters SET name=$1,profile_type=$2,tagline='',avatar_url=$3,accent=$4,backstory=$5,cast_members=$6::jsonb,lorebook='',personality=$7,scenario=$8,greeting=$9,alternate_greetings=$10::jsonb,example_dialogue=$11,response_directive=$12,boundaries=$13,source_material=$14,nsfw_enabled=$15,updated_at=now()
       WHERE id=$16 RETURNING *`,
      [c.name,c.profileType,c.avatarUrl,c.accent,c.backstory,JSON.stringify(c.cast),c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,id],
    );
    if (!result.rowCount) return null;
    await client.query("DELETE FROM character_worlds WHERE character_id=$1", [id]);
    for (const worldId of c.worldIds) await client.query("INSERT INTO character_worlds (character_id,world_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [id,worldId]);
    return result.rows[0];
  });
  if (!row) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ character: characterFromRow({ ...row, world_ids: c.worldIds }) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const result = await query("DELETE FROM characters WHERE id=$1", [id]);
  if (!result.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ ok: true });
}
