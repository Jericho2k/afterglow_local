import { randomUUID } from "node:crypto";
import { messageForViewer, messageFromRow } from "@/lib/db";
import { asUser } from "@/lib/db";
import { invalidateDerivedContinuity } from "@/lib/memory";
import type { MessageLock } from "@/lib/message-mutations";
import { deleteMessagesFromPosition, lockMessageForMutation, persistedMessagePosition, truncateMessagesAfterPosition } from "@/lib/message-mutations";
import { messageUpdateSchema } from "@/lib/schemas";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const parsed = messageUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message" }, { status: 400 });
  const requestedId = parsed.data.messageId ?? id;

  const message = await asUser(account.id, async (client) => {
    const lock = await lockMessageForMutation(client,requestedId,{ ...parsed.data, userId: account.id });
    if (!lock.ok) return lock;
    const row = lock.row;
    const resolvedId = String(row.id);
    const currentMessage = messageFromRow(row);
    const position = await persistedMessagePosition(client,String(row.conversation_id),String(row.id));
    if (parsed.data.variantIndex !== undefined) {
      const variant = currentMessage.variants[parsed.data.variantIndex];
      if (currentMessage.role !== "assistant" || variant === undefined) return null;
      /*
       * Selecting a different option changes what this turn SAYS, so it is a
       * new content version like any other edit.
       *
       * Not an obvious case, and getting it wrong is the same lie in a quieter
       * form: a later reply read whichever option was selected at the time, and
       * if switching options did not move the counter, that reply would resolve
       * its recorded version against text it never saw.
       */
      const switched = currentMessage.content !== variant;
      if (switched) {
        await client.query(
          "INSERT INTO message_versions (id,message_id,user_id,version,role,content) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id,version) DO NOTHING",
          [randomUUID(),resolvedId,account.id,Number(row.content_version || 1),currentMessage.role,currentMessage.content],
        );
      }
      const updated = await client.query(
        "UPDATE messages SET content=$1,selected_variant=$2,content_version=content_version + CASE WHEN $5 THEN 1 ELSE 0 END WHERE id=$3 AND user_id=$4 RETURNING *",
        [variant,parsed.data.variantIndex,resolvedId,account.id,switched],
      );
      if (!updated.rowCount) return null;
      await truncateMessagesAfterPosition(client,String(row.conversation_id),position,account.id);
      await invalidateDerivedContinuity(client,String(row.conversation_id),position,account.id);
      return messageFromRow(updated.rows[0]);
    }
    if (typeof parsed.data.content !== "string") return null;
    if (parsed.data.truncateAfter) {
      await truncateMessagesAfterPosition(client,String(row.conversation_id),position,account.id);
    }
    const variants = currentMessage.role === "assistant" ? [...currentMessage.variants] : [];
    if (currentMessage.role === "assistant") variants[currentMessage.selectedVariant] = parsed.data.content;
    /*
     * THE TRANSCRIPT A PAST REPLY READ MUST SURVIVE AN EDIT OF IT.
     *
     * Message content is mutable through this very handler, so a generation
     * that recorded "these were the transcript turns" would silently start
     * describing text written afterwards. The replaced version is archived and
     * the counter moves, exactly as for a memory; a generation holding the old
     * version resolves to the archived text and is labelled "edited since".
     */
    const rewritten = currentMessage.content !== parsed.data.content;
    if (rewritten) {
      await client.query(
        "INSERT INTO message_versions (id,message_id,user_id,version,role,content) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (message_id,version) DO NOTHING",
        [randomUUID(),resolvedId,account.id,Number(row.content_version || 1),currentMessage.role,currentMessage.content],
      );
    }
    const updated = await client.query(
      "UPDATE messages SET content=$1,variants=$2::jsonb,content_version=content_version + CASE WHEN $5 THEN 1 ELSE 0 END WHERE id=$3 AND user_id=$4 RETURNING *",
      [parsed.data.content,JSON.stringify(variants),resolvedId,account.id,rewritten],
    );
    if (!updated.rowCount) return null;
    await invalidateDerivedContinuity(client,String(row.conversation_id),position,account.id);
    return messageFromRow(updated.rows[0]);
  });

  if (!message) return Response.json({ error: "Message not found" }, { status: 404 });
  if ("ok" in message) return unresolvedTarget(message);
  return Response.json({ message:messageForViewer(message,isAdminAccount(account)) });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const locator = await request.json().catch(() => ({})) as { messageId?: string; conversationId?: string; messagePosition?: number; messageFingerprint?: string };
  const requestedId = locator.messageId ?? id;

  const deleted = await asUser(account.id, async (client) => {
    const lock = await lockMessageForMutation(client,requestedId,{ ...locator, userId: account.id });
    if (!lock.ok) return lock;
    const row = lock.row;
    const position = await persistedMessagePosition(client,String(row.conversation_id),String(row.id));
    await deleteMessagesFromPosition(client,String(row.conversation_id),position,account.id);
    await invalidateDerivedContinuity(client,String(row.conversation_id),position - 1,account.id);
    return row.conversation_id as string;
  });

  if (!deleted) return Response.json({ error: "Message not found" }, { status: 404 });
  if (typeof deleted !== "string") return unresolvedTarget(deleted);
  return Response.json({ ok: true, conversationId: deleted });
}

/**
 * What to say when the target could not be identified beyond doubt.
 *
 * A stale id that falls back to a position, on a row that does not match the
 * message the reader described, is not a 404 — the story is fine and something
 * IS at that position. It is a refusal: acting on it would edit or delete a
 * message the reader never chose. 409 with an instruction they can follow.
 */
function unresolvedTarget(lock: Extract<MessageLock, { ok: false }>) {
  return lock.reason === "unverified"
    ? Response.json({ error: "Reload the chat and try again." }, { status: 409 })
    : Response.json({ error: "Message not found" }, { status: 404 });
}
