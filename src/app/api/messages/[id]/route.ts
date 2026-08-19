import { requireAuth } from "@/lib/auth";
import { messageFromRow, transaction } from "@/lib/db";
import { invalidateDerivedContinuity } from "@/lib/memory";
import { deleteMessagesFromPosition, lockMessageForMutation, persistedMessagePosition, truncateMessagesAfterPosition } from "@/lib/message-mutations";
import { messageUpdateSchema } from "@/lib/schemas";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const parsed = messageUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const requestedId = parsed.data.messageId ?? id;
  const message = await transaction(async (client) => {
    const row = await lockMessageForMutation(client,requestedId,parsed.data);
    if (!row) {
      const available = parsed.data.conversationId
        ? await client.query("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id",[parsed.data.conversationId])
        : { rows: [] };
      console.error("message_mutation_miss",{
        pathId:id,requestedId,conversationId:parsed.data.conversationId ?? null,messagePosition:parsed.data.messagePosition ?? null,
        availableIds:available.rows.map((item) => String(item.id)),
      });
      return null;
    }
    const resolvedId = String(row.id);
    const currentMessage = messageFromRow(row);
    const position = await persistedMessagePosition(client,String(row.conversation_id),String(row.id));
    if (parsed.data.variantIndex !== undefined) {
      const variant = currentMessage.variants[parsed.data.variantIndex];
      if (currentMessage.role !== "assistant" || variant === undefined) return null;
      const updated = await client.query("UPDATE messages SET content=$1,selected_variant=$2 WHERE id=$3 RETURNING *", [variant,parsed.data.variantIndex,resolvedId]);
      if (!updated.rowCount) return null;
      await truncateMessagesAfterPosition(client,String(row.conversation_id),position);
      await invalidateDerivedContinuity(client,String(row.conversation_id),position);
      return messageFromRow(updated.rows[0]);
    }
    if (typeof parsed.data.content !== "string") return null;
    if (parsed.data.truncateAfter) {
      await truncateMessagesAfterPosition(client,String(row.conversation_id),position);
    }
    const variants = currentMessage.role === "assistant" ? [...currentMessage.variants] : [];
    if (currentMessage.role === "assistant") variants[currentMessage.selectedVariant] = parsed.data.content;
    const updated = await client.query("UPDATE messages SET content=$1,variants=$2::jsonb WHERE id=$3 RETURNING *", [parsed.data.content,JSON.stringify(variants),resolvedId]);
    if (!updated.rowCount) return null;
    await invalidateDerivedContinuity(client,String(row.conversation_id),position);
    return messageFromRow(updated.rows[0]);
  });
  if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({ message });
}

export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireAuth(); if (denied) return denied;
  const { id } = await context.params;
  const locator = await _request.json().catch(() => ({})) as { messageId?: string; conversationId?: string; messagePosition?: number };
  const requestedId = locator.messageId ?? id;
  const deleted = await transaction(async (client) => {
    const row = await lockMessageForMutation(client,requestedId,locator);
    if (!row) return null;
    const position = await persistedMessagePosition(client,String(row.conversation_id),String(row.id));
    await deleteMessagesFromPosition(client,String(row.conversation_id),position);
    await invalidateDerivedContinuity(client,String(row.conversation_id),position - 1);
    return row.conversation_id as string;
  });
  if (!deleted) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json({ ok: true, conversationId: deleted });
}
