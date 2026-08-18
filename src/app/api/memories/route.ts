import { randomUUID } from "node:crypto";
import { requireAuth } from "@/lib/auth";
import { memoryArcFromRow, memoryFromRow, query } from "@/lib/db";
import { memorySchema, memoryUpdateSchema } from "@/lib/schemas";

export async function GET(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const characterId = params.get("characterId");
  const conversationId = params.get("conversationId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });
  const result = conversationId
    ? await query(
      "SELECT * FROM memories WHERE character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) ORDER BY pinned DESC, importance DESC, created_at DESC",
      [characterId,conversationId],
    )
    : await query(
      "SELECT * FROM memories WHERE character_id=$1 AND conversation_id IS NULL ORDER BY pinned DESC, importance DESC, created_at DESC",
      [characterId],
    );
  const arcs = conversationId ? await query("SELECT * FROM memory_arcs WHERE conversation_id=$1 ORDER BY created_at DESC",[conversationId]) : null;
  return Response.json({ memories: result.rows.map(memoryFromRow), arcs: arcs?.rows.map(memoryArcFromRow) ?? [] });
}

export async function POST(request: Request) {
  const denied = await requireAuth(); if (denied) return denied;
  const parsed = memorySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory", details: parsed.error.flatten() }, { status: 400 });
  const m = parsed.data;
  const result = await query(
    "INSERT INTO memories (id,character_id,conversation_id,content,kind,importance,keywords,pinned,status,resolution,resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9='resolved' THEN now() ELSE NULL END) RETURNING *",
    [randomUUID(),m.characterId,m.conversationId ?? null,m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution],
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
    "UPDATE memories SET content=$1,kind=$2,importance=$3,keywords=$4,pinned=$5,status=$6,resolution=$7,resolved_at=CASE WHEN $6='resolved' THEN COALESCE(resolved_at,now()) ELSE NULL END,updated_at=now() WHERE id=$8 RETURNING *",
    [m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution,id],
  );
  if (!result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  return Response.json({ memory: memoryFromRow(result.rows[0]) });
}
