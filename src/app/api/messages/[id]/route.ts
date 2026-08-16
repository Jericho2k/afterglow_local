import { requireAuth } from "@/lib/auth";
import { messageFromRow, transaction } from "@/lib/db";
import { messageUpdateSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = messageUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const message = await transaction(async (client) => {
    const current = await client.query("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rowCount) return null;
    const row = current.rows[0];
    if (parsed.data.truncateAfter) {
      await client.query("DELETE FROM messages WHERE conversation_id=$1 AND created_at > $2", [row.conversation_id,row.created_at]);
    }
    const updated = await client.query("UPDATE messages SET content=$1 WHERE id=$2 RETURNING *", [parsed.data.content,id]);
    await client.query(
      "UPDATE conversations SET message_count=(SELECT COUNT(*) FROM messages WHERE conversation_id=$1),updated_at=now() WHERE id=$1",
      [row.conversation_id],
    );
    return messageFromRow(updated.rows[0]);
  });
  if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({ message });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const deleted = await transaction(async (client) => {
    const current = await client.query("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rowCount) return null;
    const row = current.rows[0];
    await client.query("DELETE FROM messages WHERE conversation_id=$1 AND created_at >= $2", [row.conversation_id,row.created_at]);
    await client.query(
      "UPDATE conversations SET message_count=(SELECT COUNT(*) FROM messages WHERE conversation_id=$1),updated_at=now() WHERE id=$1",
      [row.conversation_id],
    );
    return row.conversation_id as string;
  });
  if (!deleted) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({ ok: true, conversationId: deleted });
}
