import type { PoolClient } from "pg";
import { messageFromRow } from "./db";
import type { Message } from "./types";
import { recordGeneration, type GenerationRecord } from "./provenance";

/**
 * REGENERATE, MADE SAFE TO PRESS TWICE.
 *
 * Regenerate is not "send again". It targets an EXISTING assistant row and
 * appends another variant to it, which means it has two problems send and
 * continue do not have, and both were live.
 *
 *   IT DID NOT KNOW WHAT IT WAS TARGETING. The route resolved the target as
 *   "whatever the newest row happens to be, if it is an assistant" and ignored
 *   the `assistantMessageId` the browser had already sent. When those two
 *   disagree — a second tab replied, the reader's own Continue landed while the
 *   button was under their thumb, a reply persisted after the browser gave up —
 *   the reply the reader was looking at was NOT the reply that got rewritten.
 *   When the newest row was a user turn instead, the target silently became
 *   null and the "regeneration" inserted a brand new message under whatever id
 *   the browser had guessed, which collides with a real row as often as not.
 *
 *   IT ALLOCATED THE VARIANT INDEX BEFORE THE MODEL RAN. `variants.length` was
 *   read at the START of the turn and used tens of seconds later, after the
 *   whole generation. Two regenerations of one message therefore both claimed
 *   the same index: the second UPDATE overwrote the first's variant list, and
 *   the second `INSERT … ON CONFLICT DO NOTHING` on (message_id, variant_index)
 *   silently wrote nothing at all, so a real generation existed with no
 *   provenance and the inspector reported "not recorded" for it.
 *
 * Both are fixed in the same way: the target is resolved explicitly and the
 * variant index is allocated at PERSISTENCE time, inside one transaction, from
 * the row as it stands then, with the row locked. Two concurrent regenerations
 * become variants 1 and 2 rather than a race, and a conflict is reported rather
 * than swallowed.
 */

export type RegenerationTarget =
  | { ok: true; message: Message; source: "client" | "latest" }
  | { ok: false; reason: "no_reply_to_regenerate" | "target_superseded" };

/** Only ever a stored uuid; anything else cannot name a row. */
function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Which reply a regeneration is about to replace.
 *
 * The rule is narrow on purpose: a regeneration may only ever target the
 * NEWEST message in the story, and that message must be an assistant turn.
 * That is exactly what the product offers — the Regenerate control is rendered
 * on the last reply and nowhere else — so anything else is a browser working
 * from a stale picture of the story, and rewriting a different message because
 * arithmetic pointed at it is the failure mode this function exists to prevent.
 *
 * `requestedMessageId` is the browser's own answer, and it is used to tell two
 * cases apart that were previously identical:
 *
 *   IT NAMES THE NEWEST ROW. Normal. The reader is looking at what the database
 *   holds, and this is the reply they meant.
 *
 *   IT NAMES A ROW THAT IS NO LONGER NEWEST. The story moved under them. Refuse
 *   and say so, rather than regenerating whatever is newest now.
 *
 *   IT NAMES NOTHING IN THE DATABASE. A stale optimistic id, from a reply whose
 *   write never landed. That is not the reader's fault and not a conflict, so
 *   the newest assistant row is used — today's behaviour, kept deliberately.
 */
export async function resolveRegenerationTarget(client: PoolClient, input: {
  conversationId: string;
  userId: string;
  requestedMessageId?: string | null;
}): Promise<RegenerationTarget> {
  const latest = await client.query(
    "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
    [input.conversationId, input.userId],
  );
  const newest = latest.rows[0];
  const requested = input.requestedMessageId && isUuid(input.requestedMessageId) ? input.requestedMessageId : null;

  if (requested && newest && String(newest.id) !== requested) {
    // Does the id the browser named exist at all? A stale optimistic id does
    // not, and is a different situation from a real reply that has been
    // overtaken.
    const known = await client.query(
      "SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2 AND user_id=$3",
      [requested, input.conversationId, input.userId],
    );
    if (known.rowCount) return { ok: false, reason: "target_superseded" };
  }

  if (!newest || String(newest.role) !== "assistant") return { ok: false, reason: "no_reply_to_regenerate" };
  return {
    ok: true,
    message: messageFromRow(newest),
    source: requested && String(newest.id) === requested ? "client" : "latest",
  };
}

export type VariantCommit =
  | { ok: true; variants: string[]; variantIndex: number }
  | { ok: false; reason: "target_missing" };

/**
 * A variant index that already has a generation row.
 *
 * Thrown rather than returned, because the only correct response is to abandon
 * the transaction: `message_generations` is UNIQUE on (message_id,
 * variant_index) and `recordGeneration` is `ON CONFLICT DO NOTHING`, so a
 * conflict means the row this generation would have claimed belongs to a
 * DIFFERENT generation. Storing the variant anyway would leave a stored reply
 * whose provenance describes something else — which is worse than the failure,
 * and is precisely the invariant `message_generations` exists to hold.
 *
 * The locked read makes this unreachable within one database; it is reachable
 * across two writers that are not both holding the lock, and by anything that
 * writes provenance out of band. Reaching it is a bug somewhere, so it is an
 * error with a name rather than a boolean nobody checks.
 */
export class ProvenanceConflictError extends Error {
  readonly messageId: string;
  readonly variantIndex: number;

  constructor(messageId: string, variantIndex: number) {
    super("A generation row already exists for this message and variant");
    this.name = "ProvenanceConflictError";
    this.messageId = messageId;
    this.variantIndex = variantIndex;
  }
}

/**
 * Appends one generated variant to an existing reply, and records it.
 *
 * ONE TRANSACTION, AND THE ROW IS LOCKED FOR IT. `SELECT … FOR UPDATE` is what
 * makes the read-modify-write of `variants` atomic; without it two
 * regenerations racing on one message both read the same array and one of them
 * is lost. Provenance is written in the same transaction as the message and a
 * failure to write it ABANDONS the transaction, so there is no state in which a
 * stored variant lacks the record of what produced it.
 *
 * The message-level columns keep describing the CURRENTLY SELECTED variant,
 * which is what they have always meant and what older clients read. The row in
 * `message_generations` is the record that nothing later may revise.
 */
export async function commitRegeneratedVariant(client: PoolClient, input: {
  messageId: string;
  userId: string;
  conversationId: string;
  text: string;
  memoryIds: string[];
  arcIds: string[];
  contextProvenance: unknown;
  generation: Omit<GenerationRecord, "messageId" | "conversationId" | "userId" | "variantIndex">;
}): Promise<VariantCommit> {
  const locked = await client.query(
    "SELECT id,content,variants FROM messages WHERE id=$1 AND user_id=$2 AND role='assistant' FOR UPDATE",
    [input.messageId, input.userId],
  );
  const row = locked.rows[0];
  if (!row) return { ok: false, reason: "target_missing" };

  const stored = Array.isArray(row.variants) ? row.variants.filter((item: unknown): item is string => typeof item === "string") : [];
  // A reply written before variants existed carries its text in `content` only,
  // so its first variant is that text — otherwise regenerating it would discard
  // the original rather than offer it as option one.
  const existing = stored.length ? stored : [String(row.content ?? "")].filter(Boolean);
  const variants = [...existing, input.text];
  const variantIndex = variants.length - 1;

  await client.query(
    `UPDATE messages SET content=$1,variants=$2::jsonb,selected_variant=$3,
       memory_ids=$4::uuid[],memory_arc_ids=$5::uuid[],context_provenance=$6::jsonb
     WHERE id=$7 AND user_id=$8`,
    [input.text, JSON.stringify(variants), variantIndex, input.memoryIds, input.arcIds,
      JSON.stringify(input.contextProvenance), input.messageId, input.userId],
  );
  await client.query("UPDATE conversations SET updated_at=now() WHERE id=$1 AND user_id=$2", [input.conversationId, input.userId]);

  /*
   * A VARIANT IS NEVER STORED WITHOUT ITS GENERATION ROW.
   *
   * This used to return the conflict as a flag and let the caller log it, which
   * left exactly the state `message_generations` exists to prevent: a stored
   * variant whose provenance row belongs to some other generation, and an
   * inspector confidently describing the wrong context. Throwing rolls the
   * whole transaction back — the `UPDATE` above included — so the message is
   * left exactly as it was and the reader is told the reply could not be saved,
   * which is true.
   */
  const recorded = await recordGeneration(client, {
    ...input.generation,
    messageId: input.messageId,
    conversationId: input.conversationId,
    userId: input.userId,
    variantIndex,
  });
  if (!recorded) throw new ProvenanceConflictError(input.messageId, variantIndex);
  return { ok: true, variants, variantIndex };
}

/**
 * Stores a brand new assistant message — a send or a continue — with its
 * provenance, in one transaction for the same reason.
 */
export async function commitNewAssistantMessage(client: PoolClient, input: {
  messageId: string;
  userId: string;
  conversationId: string;
  text: string;
  memoryIds: string[];
  arcIds: string[];
  contextProvenance: unknown;
  generation: Omit<GenerationRecord, "messageId" | "conversationId" | "userId" | "variantIndex">;
}) {
  await client.query(
    `INSERT INTO messages (id,conversation_id,user_id,role,content,variants,selected_variant,memory_ids,memory_arc_ids,context_provenance)
     VALUES ($1,$2,$3,'assistant',$4,$5::jsonb,0,$6::uuid[],$7::uuid[],$8::jsonb)`,
    [input.messageId, input.conversationId, input.userId, input.text, JSON.stringify([input.text]),
      input.memoryIds, input.arcIds, JSON.stringify(input.contextProvenance)],
  );
  await client.query(
    "UPDATE conversations SET message_count=message_count+1,updated_at=now() WHERE id=$1 AND user_id=$2",
    [input.conversationId, input.userId],
  );
  // Same invariant, same remedy. A send or a continue writes variant 0 of a row
  // that did not exist a moment ago, so a conflict here means the id was reused
  // — and a reply stored under provenance describing a different generation is
  // not an outcome worth having.
  const recorded = await recordGeneration(client, {
    ...input.generation,
    messageId: input.messageId,
    conversationId: input.conversationId,
    userId: input.userId,
    variantIndex: 0,
  });
  if (!recorded) throw new ProvenanceConflictError(input.messageId, 0);
  return { ok: true as const, variants: [input.text], variantIndex: 0 };
}
