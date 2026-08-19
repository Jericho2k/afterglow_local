import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { personaFromRow, query, transaction } from "@/lib/db";
import { personaSchema } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const result = await query("SELECT * FROM personas ORDER BY is_default DESC,updated_at DESC");
  return Response.json({ personas: result.rows.map(personaFromRow) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = personaSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid persona" }, { status: 400 });
  const id = randomUUID(); const value = parsed.data;
  const row = await transaction(async (client) => {
    if (value.isDefault) await client.query("UPDATE personas SET is_default=false WHERE is_default=true");
    const result = await client.query("INSERT INTO personas (id,name,description,avatar_url,accent,is_default) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [id,value.name,value.description,value.avatarUrl,value.accent,value.isDefault]);
    return result.rows[0];
  });
  return Response.json({ persona: personaFromRow(row) }, { status: 201 });
}
