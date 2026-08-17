import { requireAuth } from "@/lib/auth";
import { characterFromRow, query } from "@/lib/db";
import { characterSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = characterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid character", details: parsed.error.flatten() }, { status: 400 });
  const c = parsed.data;
  const result = await query(
    `UPDATE characters SET name=$1,tagline=$2,avatar_url=$3,accent=$4,backstory=$5,personality=$6,scenario=$7,greeting=$8,example_dialogue=$9,response_directive=$10,boundaries=$11,nsfw_enabled=$12,updated_at=now()
     WHERE id=$13 RETURNING *`,
    [c.name,c.tagline,c.avatarUrl,c.accent,c.backstory,c.personality,c.scenario,c.greeting,c.exampleDialogue,c.responseDirective,c.boundaries,c.nsfwEnabled,id],
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
