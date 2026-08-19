import { requireAuth } from "@/lib/auth";
import { personaFromRow, query, transaction } from "@/lib/db";
import { personaSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = personaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid persona" }, { status: 400 });
  const value = parsed.data;
  const current = await query("SELECT is_default FROM personas WHERE id=$1", [id]);
  if (!current.rowCount) return Response.json({ error: "Persona not found" }, { status: 404 });
  if (current.rows[0].is_default && !value.isDefault) return Response.json({ error: "Make another persona the default before unsetting this one" }, { status: 409 });
  const row = await transaction(async (client) => {
    if (value.isDefault) await client.query("UPDATE personas SET is_default=false WHERE is_default=true AND id<>$1", [id]);
    const result = await client.query("UPDATE personas SET name=$1,description=$2,avatar_url=$3,accent=$4,is_default=$5,updated_at=now() WHERE id=$6 RETURNING *", [value.name,value.description,value.avatarUrl,value.accent,value.isDefault,id]);
    return result.rows[0] || null;
  });
  if (!row) return Response.json({ error: "Persona not found" }, { status: 404 });
  return Response.json({ persona: personaFromRow(row) });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const current = await query("SELECT is_default FROM personas WHERE id=$1", [id]);
  if (!current.rowCount) return Response.json({ error: "Persona not found" }, { status: 404 });
  if (current.rows[0].is_default) return Response.json({ error: "Choose another default persona before deleting this one" }, { status: 409 });
  await query("DELETE FROM personas WHERE id=$1", [id]);
  return Response.json({ ok: true });
}
