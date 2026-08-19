import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { query, worldFromRow } from "@/lib/db";
import { worldSchema } from "@/lib/schemas";

export async function GET() {
  const denied = await requireAuth(); if (denied) return denied;
  const [result,links] = await Promise.all([query("SELECT * FROM worlds ORDER BY updated_at DESC"),query("SELECT world_id FROM character_worlds")]);
  return Response.json({ worlds: result.rows.map((row) => ({ ...worldFromRow(row), characterCount: links.rows.filter((link) => String(link.world_id) === String(row.id)).length })) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = worldSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Invalid world" }, { status: 400 });
  const id = randomUUID(); const value = parsed.data;
  const result = await query("INSERT INTO worlds (id,name,description,content) VALUES ($1,$2,$3,$4) RETURNING *", [id,value.name,value.description,value.content]);
  return Response.json({ world: worldFromRow(result.rows[0]) }, { status: 201 });
}
