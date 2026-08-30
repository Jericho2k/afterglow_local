import { randomUUID } from "node:crypto";
import { ownedConversation, readableCharacter } from "@/lib/access";
import { asUser, coreCanonFromRow, memoryArcFromRow, memoryFromRow } from "@/lib/db";
import { forgetMemoryEmbedding } from "@/lib/memory-v2";
import { memorySchema, memoryUpdateSchema } from "@/lib/schemas";
import { currentAccount, unauthorized } from "@/lib/session";

/**
 * The reader's own memory archive for one story.
 *
 * This used to be an administrator's diagnostic surface. It is not one: a
 * memory is a fact about somebody's private story, written by a machine on
 * their behalf, and being unable to read or correct it is the actual problem —
 * a reader who is told "she forgot our anniversary" has no way to see what she
 * was told to remember, let alone fix it.
 *
 * What changed is who may call it, and NOTHING about what it can reach. Every
 * statement is still executed as the calling account, still carries an explicit
 * `user_id` predicate, and both ids in the request are resolved through
 * `src/lib/access.ts` before anything is read or written. A memory belongs to
 * the account that accumulated it, never to the creator of the character it is
 * about, so a published creation exposes nothing here.
 *
 * Derived layers — historical arcs and Core Canon — are returned READ ONLY.
 * They are rebuilt from the atomic archive on a cadence, so an edit to one of
 * them would be silently discarded the next time curation ran; editing the
 * atoms is the edit that lasts, and it is the one this route offers.
 */

/** Both ids in a memory request, resolved as this account before any read. */
async function resolveScope(client: Parameters<typeof readableCharacter>[0], userId: string, characterId: string, conversationId: string | null) {
  if (!(await readableCharacter(client, userId, characterId))) return null;
  if (conversationId && !(await ownedConversation(client, userId, conversationId))) return null;
  return { characterId, conversationId };
}

export async function GET(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const params = new URL(request.url).searchParams;
  const characterId = params.get("characterId");
  const conversationId = params.get("conversationId");
  // Superseded rows stay in the archive so an older reply can still say what it
  // recalled. They are excluded from the library unless it asks for them.
  const includeRemoved = params.get("includeRemoved") === "1";
  if (!characterId) return Response.json({ error: "characterId is required" }, { status: 400 });

  const payload = await asUser(account.id, async (client) => {
    const scope = await resolveScope(client, account.id, characterId, conversationId);
    if (!scope) return null;
    // Memories are private per account even when the character is published,
    // so the owner predicate is on the memory rows, not on the character.
    const result = conversationId
      ? await client.query(
        `SELECT * FROM memories WHERE user_id=$3 AND character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL)
         ${includeRemoved ? "" : "AND status<>'superseded'"} ORDER BY pinned DESC, importance DESC, created_at DESC`,
        [characterId,conversationId,account.id],
      )
      : await client.query(
        `SELECT * FROM memories WHERE user_id=$2 AND character_id=$1 AND conversation_id IS NULL
         ${includeRemoved ? "" : "AND status<>'superseded'"} ORDER BY pinned DESC, importance DESC, created_at DESC`,
        [characterId,account.id],
      );
    const arcs = conversationId
      ? await client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC",[conversationId,account.id])
      : null;
    const canon = conversationId
      ? await client.query("SELECT * FROM core_canon_entries WHERE conversation_id=$1 AND user_id=$2 AND status='active' ORDER BY importance DESC,created_at ASC",[conversationId,account.id])
      : null;
    const conversation = conversationId
      ? await client.query("SELECT summary FROM conversations WHERE id=$1 AND user_id=$2",[conversationId,account.id])
      : null;
    return {
      memories: result.rows.map(memoryFromRow),
      arcs: arcs?.rows.map(memoryArcFromRow) ?? [],
      coreCanon: canon?.rows.map(coreCanonFromRow) ?? [],
      summary: String(conversation?.rows[0]?.summary || ""),
      /** Derived layers are shown, never written, from here. See above. */
      editable: { memories: true, arcs: false, coreCanon: false, summary: false },
    };
  });

  if (!payload) return Response.json({ error: "Character or conversation not found" }, { status: 404 });
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
    const scope = await resolveScope(client, account.id, m.characterId, m.conversationId ?? null);
    if (!scope) return null;
    const result = await client.query(
      "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance,keywords,pinned,status,resolution,origin,resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'user',CASE WHEN $10='resolved' THEN now() ELSE NULL END) RETURNING *",
      [randomUUID(),m.characterId,m.conversationId ?? null,account.id,m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution],
    );
    return result.rows[0];
  });

  if (!row) return Response.json({ error: "Character or conversation not found" }, { status: 404 });
  return Response.json({ memory: memoryFromRow(row) }, { status: 201 });
}

/**
 * Removal is supersession, not deletion.
 *
 * A hard delete would take the row out from under two things that legitimately
 * point at it: the `memory_ids` recorded on every reply that recalled it, and
 * the `source_memory_ids` a Core Canon entry was derived from. Both would go
 * from "here is what that reply read" to a dangling id, which is exactly the
 * kind of quiet history rewrite the inspector exists to prevent.
 *
 * `status='superseded'` is already the status retrieval refuses to rank, so
 * this removes the memory from every future reply — which is what the reader
 * asked for — while the past stays legible. `?purge=1` is offered for a reader
 * who wants the text itself gone; it is the only path that actually deletes,
 * and it is deliberately not the default.
 */
export async function DELETE(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const purge = url.searchParams.get("purge") === "1";
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const result = await asUser(account.id, async (client) => {
    if (purge) {
      // The embedding row cascades with the memory; nothing else may.
      return client.query("DELETE FROM memories WHERE id=$1 AND user_id=$2", [id, account.id]);
    }
    return client.query(
      "UPDATE memories SET status='superseded',superseded_at=now(),updated_at=now() WHERE id=$1 AND user_id=$2 RETURNING id",
      [id, account.id],
    );
  });
  // A superseded memory must not keep answering semantic queries.
  if (result.rowCount && !purge) await forgetMemoryEmbedding(account.id, id);
  if (!result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  return Response.json({ ok: true, removed: purge ? "deleted" : "superseded" });
}

export async function PATCH(request: Request) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const parsed = memoryUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid memory" }, { status: 400 });
  const m = parsed.data;
  const updated = await asUser(account.id, async (client) => {
    const before = await client.query("SELECT content FROM memories WHERE id=$1 AND user_id=$2",[id,account.id]);
    if (!before.rowCount) return null;
    const result = await client.query(
      "UPDATE memories SET content=$1,kind=$2,importance=$3,keywords=$4,pinned=$5,status=$6,resolution=$7,resolved_at=CASE WHEN $6='resolved' THEN COALESCE(resolved_at,now()) ELSE NULL END,superseded_at=CASE WHEN $6='superseded' THEN COALESCE(superseded_at,now()) ELSE NULL END,updated_at=now() WHERE id=$8 AND user_id=$9 RETURNING *",
      [m.content,m.kind,m.importance,m.keywords,m.pinned,m.status,m.resolution,id,account.id],
    );
    /*
     * An edited memory must not be found by its OLD meaning.
     *
     * The stored vector describes the text that was replaced. Leaving it in
     * place would let the previous wording keep winning semantic queries — the
     * memory reads one way in the archive and retrieves another way in the
     * prompt, which is worse than having no vector at all. Dropping the row
     * makes retrieval fall back to lexical scoring for this memory until the
     * ordinary backfill re-embeds the new text, which it does on its own
     * because the content hash no longer matches.
     */
    return { result, contentChanged: String(before.rows[0].content) !== m.content };
  });
  if (!updated?.result.rowCount) return Response.json({ error: "Memory not found" }, { status: 404 });
  if (updated.contentChanged) await forgetMemoryEmbedding(account.id, id);
  return Response.json({ memory: memoryFromRow(updated.result.rows[0]) });
}
