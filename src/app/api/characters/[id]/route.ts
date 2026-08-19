import { requireAuth } from "@/lib/auth";
import { characterFromRow, query } from "@/lib/db";
import { characterSchema, characterValidationMessage } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: characterValidationMessage(parsed.error), details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;
  const result = await query(
    `UPDATE characters SET name=$1,profile_type=$2,tagline=$3,avatar_url=$4,accent=$5,backstory=$6,cast_members=$7::jsonb,lorebook=$8,personality=$9,scenario=$10,greeting=$11,alternate_greetings=$12::jsonb,example_dialogue=$13,response_directive=$14,boundaries=$15,source_material=$16,nsfw_enabled=$17,updated_at=now()
     WHERE id=$18 RETURNING *`,
    [c.name,c.profileType,c.tagline,c.avatarUrl,c.accent,c.backstory,JSON.stringify(c.cast),c.lorebook,c.personality,c.scenario,c.greeting,JSON.stringify(c.alternateGreetings),c.exampleDialogue,c.responseDirective,c.boundaries,c.sourceMaterial,c.nsfwEnabled,id],
  );
  if (!result.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ character: characterFromRow(result.rows[0]) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const result = await query("DELETE FROM characters WHERE id=$1", [id]);
  if (!result.rowCount) return Response.json({ error: "Character not found" }, { status: 404 });
  return Response.json({ ok: true });
}
