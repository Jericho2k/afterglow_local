import type { PoolClient } from "pg";

export type MessageLocator = { conversationId?: string; messagePosition?: number };

export async function lockMessageForMutation(client: PoolClient, id: string, locator: MessageLocator = {}) {
  const direct = await client.query("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [id]);
  if (direct.rowCount || !locator.conversationId || !locator.messagePosition) return direct.rows[0] ?? null;

  // A streamed/optimistic message can briefly retain its browser-generated ID.
  // Position within a conversation is stable while the inline editor is open,
  // so use it only as a narrowly scoped recovery key when the supplied ID is stale.
  const recovered = await client.query(
    `SELECT * FROM messages WHERE conversation_id=$1
     ORDER BY created_at ASC,id ASC OFFSET $2 LIMIT 1 FOR UPDATE`,
    [locator.conversationId, locator.messagePosition - 1],
  );
  return recovered.rows[0] ?? null;
}

export async function truncateMessagesAfterPosition(client: PoolClient, conversationId: string, position: number) {
  return client.query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE conversation_id=$1
       ORDER BY created_at ASC,id ASC OFFSET $2
     )`,
    [conversationId, Math.max(0,position)],
  );
}

export async function deleteMessagesFromPosition(client: PoolClient, conversationId: string, position: number) {
  return client.query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE conversation_id=$1
       ORDER BY created_at ASC,id ASC OFFSET $2
     )`,
    [conversationId, Math.max(0,position - 1)],
  );
}
