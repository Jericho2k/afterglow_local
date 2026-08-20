import { randomUUID } from "node:crypto";
import { ownedConversation, readableCharacter } from "@/lib/access";
import { asUser, memoryArcFromRow, memoryFromRow } from "@/lib/db";
import { memorySchema, memoryUpdateSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;
  const characterId = params.get("characterId");
  const conversationId = params.get("conversationId");
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });

  const payload = await asUser(account.id, async (client) => {
    // Memories are private per account even when the character is published,
    // so the owner predicate is on the memory rows, not on the character.
    const result = conversationId
      ? await client.query(
        "SELECT * FROM memories WHERE user_id=$3 AND character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) ORDER BY pinned DESC, importance DESC, created_at DESC",
        [characterId,conversationId,account.id],
      )
      : await client.query(
        "SELECT * FROM memories WHERE user_id=$2 AND character_id=$1 AND conversation_id IS NULL ORDER BY pinned DESC, importance DESC, created_at DESC",
        [characterId,account.id],
      );
    const arcs = conversationId
      ? await client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC",[conversationId,account.id])
      : null;
    return { memories: result.rows.map(memoryFromRow), arcs: arcs?.rows.map(memoryArcFromRow) ?? [] };
  });

  return Response.json(payload);
}

export async function POST(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const parsed = memorySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory", details: parsed.error.flatten() }, { status: 400 });
  const m = parsed.data;

  const row = await asUser(account.id, async (client) => {
    // Both ids come from the request body, so both are verified: the character
    // must be readable by this account and the conversation must be its own.
    if (!(await readableCharacter(client, account.id, m.characterId))) return null;
    if (m.conversationId && !(await ownedConversation(client, account.id, m.conversationId))) return null;
    const result = await client.query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance,keywords,pinned,status,resolution,resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $10='resolved' THEN now() ELSE NULL END) RETURNING *",
      [randomUUID(),m.characterId,m.conversationId ?? null,account.id,m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution],
    );
    return result.rows[0];
  });

  if (!row) return Response.json({ error: "Character or conversation not found" }, { status: 404 });
  return Response.json({ memory: memoryFromRow(row) }, { status: 201 });
}

export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const result = await asUser(account.id, (client) => client.query("DELETE FROM memories WHERE id=$1 AND user_id=$2", [id, account.id]));
  if (!result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  return Response.json({ ok: true });
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const parsed = memoryUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory" }, { status: 400 });
  const m = parsed.data;
  const result = await asUser(account.id, (client) => client.query(
    "UPDATE memories SET content=$1,kind=$2,importance=$3,keywords=$4,pinned=$5,status=$6,resolution=$7,resolved_at=CASE WHEN $6='resolved' THEN COALESCE(resolved_at,now()) ELSE NULL END,updated_at=now() WHERE id=$8 AND user_id=$9 RETURNING *",
    [m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution,id,account.id],
  ));
  if (!result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  return Response.json({ memory: memoryFromRow(result.rows[0]) });
}
