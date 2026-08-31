import type { PoolClient } from "pg";
import { fingerprintMatches } from "./message-identity";

export type MessageLocator = {
  conversationId?: string;
  /**
   * Position of the target counted from the START OF THE CONVERSATION, 1-based.
   *
   * Not from the start of the rendered window. The chat opens on a bounded
   * window of the newest messages, so the client adds the window's own offset
   * (`windowStartPosition`) before sending this. A window-relative index
   * arriving here would name a message hundreds of replies earlier.
   */
  messagePosition?: number;
  /** Digest of the message the client is looking at; see message-identity.ts. */
  messageFingerprint?: string;
  userId?: string;
};

/**
 * Why a lock failed, so the route can tell "gone" from "cannot prove it".
 *
 * `missing` is an ordinary 404. `unverified` means a row exists at the
 * requested position but nothing proves it is the one the reader meant, and
 * the honest answer is to ask them to reload rather than to mutate a message
 * chosen by arithmetic.
 */
export type MessageLock =
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; reason: "missing" | "unverified" };

export async function persistedMessagePosition(client: PoolClient, conversationId: string, messageId: string) {
  const result = await client.query(
    `SELECT COUNT(*)::int position
     FROM messages candidate
     JOIN messages target ON target.id=$2 AND target.conversation_id=$1
     WHERE candidate.conversation_id=$1 AND (
       candidate.created_at < target.created_at
       OR (candidate.created_at=target.created_at AND candidate.id::text <= target.id::text)
     )`,
    [conversationId,messageId],
  );
  return Number(result.rows[0]?.position ?? 0);
}

/**
 * The row a mutation is about to change, locked, or a reason it could not be
 * identified beyond doubt.
 *
 * The id is tried first and is the normal path. The positional fallback only
 * runs when the id resolves to nothing, and it now has to PROVE its answer: the
 * recovered row must carry the exact role and text the client said it was
 * looking at. Without that proof — no fingerprint sent, or a row that does not
 * match it — the lock fails as `unverified` and nothing is written.
 */
export async function lockMessageForMutation(client: PoolClient, id: string, locator: MessageLocator = {}): Promise<MessageLock> {
  // The owner predicate makes a message id belonging to another account
  // resolve to nothing, so neither branch below can be used to reach across
  // accounts even before row level security is consulted.
  const owner = locator.userId ?? null;
  const direct = isUuid(id)
    ? owner
      ? await client.query("SELECT * FROM messages WHERE id=$1 AND user_id=$2 FOR UPDATE", [id, owner])
      : await client.query("SELECT * FROM messages WHERE id=$1 FOR UPDATE", [id])
    : { rowCount: 0, rows: [] as Record<string, unknown>[] };
  if (direct.rowCount) return { ok: true, row: direct.rows[0] };
  if (!locator.conversationId || !locator.messagePosition) return { ok: false, reason: "missing" };

  // A message whose write never landed under the id the browser still holds can
  // be recovered by where it sits in the conversation — but only if the row
  // found there is demonstrably the message on screen.
  const recovered = owner
    ? await client.query(
      `SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$3
       ORDER BY created_at ASC,id ASC OFFSET $2 LIMIT 1 FOR UPDATE`,
      [locator.conversationId, locator.messagePosition - 1, owner],
    )
    : await client.query(
      `SELECT * FROM messages WHERE conversation_id=$1
       ORDER BY created_at ASC,id ASC OFFSET $2 LIMIT 1 FOR UPDATE`,
      [locator.conversationId, locator.messagePosition - 1],
    );
  const row = recovered.rows[0];
  if (!row) return { ok: false, reason: "missing" };
  return (await fingerprintMatches(row, locator.messageFingerprint))
    ? { ok: true, row }
    : { ok: false, reason: "unverified" };
}

export async function truncateMessagesAfterPosition(client: PoolClient, conversationId: string, position: number, userId?: string) {
  return client.query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE conversation_id=$1 AND ($3::uuid IS NULL OR user_id=$3)
       ORDER BY created_at ASC,id ASC OFFSET $2
     )`,
    [conversationId, Math.max(0,position), userId ?? null],
  );
}

export async function deleteMessagesFromPosition(client: PoolClient, conversationId: string, position: number, userId?: string) {
  return client.query(
    `DELETE FROM messages WHERE id IN (
       SELECT id FROM messages WHERE conversation_id=$1 AND ($3::uuid IS NULL OR user_id=$3)
       ORDER BY created_at ASC,id ASC OFFSET $2
     )`,
    [conversationId, Math.max(0,position - 1), userId ?? null],
  );
}

/**
 * A browser-generated id is a uuid, and so is every stored one. Anything else
 * cannot name a row, and asking Postgres to compare it to a uuid column raises
 * rather than returning nothing — which would turn a stale id into a 500.
 */
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
