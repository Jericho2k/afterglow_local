import { requireAuth } from "@/lib/auth";
import { query, worldFromRow } from "@/lib/db";
import { worldSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const value = parsed.data;
  const result = await query("UPDATE worlds SET name=$1,description=$2,content=$3,updated_at=now() WHERE id=$4 RETURNING *", [value.name,value.description,value.content,id]);
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ world: worldFromRow(result.rows[0]) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const result = await query("DELETE FROM worlds WHERE id=$1", [id]);
  if (!result.rowCount) return Response.json({ error: "World not found" }, { status: 404 });
  return Response.json({ ok: true });
}
