import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { memoryFromRow, query } from "@/lib/db";
import { memorySchema, memoryUpdateSchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const characterId = new URL(request.url).searchParams.get("characterId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });
  const result = await query("SELECT * FROM memories WHERE character_id=$1 ORDER BY pinned DESC, importance DESC, created_at DESC", [characterId]);
  return Response.json({ memories: result.rows.map(memoryFromRow) });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = memorySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory", details: parsed.error.flatten() }, { status: 400 });
  const m = parsed.data;
  const result = await query(
    "INSERT INTO memories (id,character_id,conversation_id,content,kind,importance,keywords,pinned) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
    [randomUUID(),m.characterId,m.conversationId ?? null,m.content,m.kind,m.importance,m.keywords,m.pinned],
  );
  return Response.json({ memory: memoryFromRow(result.rows[0]) }, { status: 201 });
}

export async function DELETE(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  await query("DELETE FROM memories WHERE id=$1", [id]);
  return Response.json({ ok: true });
}

export async function PATCH(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const parsed = memoryUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory" }, { status: 400 });
  const m = parsed.data;
  const result = await query(
    "UPDATE memories SET content=$1,kind=$2,importance=$3,keywords=$4,pinned=$5,updated_at=now() WHERE id=$6 RETURNING *",
    [m.content,m.kind,m.importance,m.keywords,m.pinned,id],
  );
  if (!result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  return Response.json({ memory: memoryFromRow(result.rows[0]) });
}
