import { requireAuth } from "@/lib/auth";
import { conversationFromRow, query } from "@/lib/db";
import { conversationUpdateSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = conversationUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid conversation title" }, { status: 400 });
  const result = await query("UPDATE conversations SET title=$1,updated_at=now() WHERE id=$2 RETURNING *", [parsed.data.title,id]);
  if (!result.rowCount) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ conversation: conversationFromRow(result.rows[0]) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const result = await query("DELETE FROM conversations WHERE id=$1 RETURNING character_id", [id]);
  if (!result.rowCount) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ ok: true, characterId: result.rows[0].character_id });
}
