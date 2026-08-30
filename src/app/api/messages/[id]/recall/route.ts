import { asUser, coreCanonFromRow, memoryArcFromRow, memoryFromRow, messageFromRow, sceneStateFromRow } from "@/lib/db";
import { sceneFieldsOf } from "@/lib/scene-state";
import { currentAccount, isAdminAccount, unauthorized } from "@/lib/session";

/**
 * What one reply was actually written from.
 *
 * "Recalled 6" used to be counted from the ids stored on the message, while the
 * panel behind it resolved those ids against a list the browser had loaded when
 * the CHAT was opened. Memory consolidation runs after every reply, so any
 * memory created since then was recalled by name and then found by nobody: the
 * count said six and the panel said nothing. Two sources, one of them stale.
 *
 * There is one source now, and it is this. The count and the contents are the
 * same array, so they cannot disagree — including for a memory that has since
 * been edited away or superseded, which is reported as an item rather than
 * silently dropped. A number that does not match what is under it is worse than
 * a smaller number.
 *
 * It answers a wider question than it used to, because "what did you remember"
 * was only part of what a reader wants to know. The transcript window, the
 * curated canon, the current scene, and whether a rolling summary was in the
 * prompt are the rest of "what story context did you use", and all four are
 * read from `context_provenance` — recorded WITH the reply, because none of
 * them can be reconstructed afterwards. A reply written before that column
 * existed simply reports the parts it does have.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN, for anybody: the system prompt or any
 * part of it, the creation's definition, response directives, boundaries, world
 * documents, persona text, provider or model identifiers, API material, or the
 * rolling summary's text. This is a story-context inspector, not a prompt dump.
 * Every item below is resolved from the CALLER'S OWN rows — their memories,
 * their arcs, their canon, their scene — so there is no field here through
 * which another creator's private material could arrive. Row level security and
 * an explicit owner predicate scope every read.
 *
 * Ranking internals — semantic scores, weights, rejection reasons — remain
 * behind the administrator boundary. They answer a question about the machine;
 * the rest of this answers a question about the story.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const diagnostics = isAdminAccount(account);

  const payload = await asUser(account.id, async (client) => {
    const messageResult = await client.query("SELECT * FROM messages WHERE id=$1 AND user_id=$2", [id, account.id]);
    if (!messageResult.rowCount) return null;
    const row = messageResult.rows[0];
    const message = messageFromRow(row);
    const provenance = (row.context_provenance && typeof row.context_provenance === "object" ? row.context_provenance : {}) as Record<string, unknown>;

    /*
     * Explicit placeholders rather than `= ANY($1::uuid[])`.
     *
     * The array form is fine in PostgreSQL and unsupported by the in-memory
     * engine the tests run against, and a query shape that cannot be tested is
     * worse than a slightly longer one — the same trade the worlds route makes.
     * Every list is bounded by the account's own recall limits, so this can
     * never grow a statement without bound.
     */
    const byIds = async (table: "memories" | "memory_arcs" | "core_canon_entries", ids: string[]) => {
      if (!ids.length) return [] as Array<Record<string, unknown>>;
      const placeholders = ids.map((_value, index) => `$${index + 2}`).join(",");
      const result = await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND id IN (${placeholders})`, [account.id, ...ids]);
      return result.rows;
    };
    const canonIds = Array.isArray(provenance.canonIds) ? provenance.canonIds.map(String).slice(0, 40) : [];
    const memories = { rows: await byIds("memories", message.memoryIds) };
    const arcs = { rows: await byIds("memory_arcs", message.arcIds) };
    const canon = { rows: await byIds("core_canon_entries", canonIds) };

    const memoryById = new Map(memories.rows.map((item) => [String(item.id), memoryFromRow(item)]));
    const arcById = new Map(arcs.rows.map((item) => [String(item.id), memoryArcFromRow(item)]));
    const canonById = new Map(canon.rows.map((item) => [String(item.id), coreCanonFromRow(item)]));

    // Stored order is recall order, and every stored id produces exactly one
    // item — present or not. That equality is the whole fix.
    const items = [
      ...message.memoryIds.map((memoryId) => {
        const memory = memoryById.get(memoryId);
        return memory
          ? {
            kind: "memory" as const, id: memoryId, available: true as const,
            content: memory.content, memoryKind: memory.kind, status: memory.status,
            importance: memory.importance, resolution: memory.resolution,
            origin: memory.origin ?? "consolidation",
            scope: memory.conversationId ? ("chat" as const) : ("creation" as const),
          }
          : { kind: "memory" as const, id: memoryId, available: false as const };
      }),
      ...message.arcIds.map((arcId) => {
        const arc = arcById.get(arcId);
        return arc
          ? {
            kind: "arc" as const, id: arcId, available: true as const,
            summary: arc.summary, startMessageCount: arc.startMessageCount, endMessageCount: arc.endMessageCount,
          }
          : { kind: "arc" as const, id: arcId, available: false as const };
      }),
      ...canonIds.map((canonId) => {
        const entry = canonById.get(canonId);
        return entry
          ? {
            kind: "canon" as const, id: canonId, available: true as const,
            content: entry.content, category: entry.category, importance: entry.importance, status: entry.status,
          }
          : { kind: "canon" as const, id: canonId, available: false as const };
      }),
    ];

    /*
     * The transcript window, described rather than repeated.
     *
     * The reader is already looking at the transcript, so echoing it back is
     * noise. What they cannot see is HOW MUCH of it the writer was given, and
     * where that window started — which is exactly the question behind "why
     * did she forget what I said an hour ago".
     */
    const storedTranscript = (provenance.transcript && typeof provenance.transcript === "object" ? provenance.transcript : null) as Record<string, unknown> | null;
    const transcript = storedTranscript
      ? {
        recorded: true as const,
        messages: Number(storedTranscript.messages || 0),
        firstMessageId: storedTranscript.firstMessageId ? String(storedTranscript.firstMessageId) : null,
        estimatedTokens: Number(storedTranscript.estimatedTokens || 0),
        trimmedToFit: Number(storedTranscript.trimmedToFit || 0),
      }
      : { recorded: false as const };

    /*
     * The rolling summary is reported as PRESENT AND HOW LARGE, never as text.
     *
     * There is exactly one summary row per story and consolidation overwrites
     * it, so the text available now is not the text this reply read. Showing it
     * beside an older reply would be a confident, wrong answer; saying a
     * summary of a given size was in the prompt is the true one. The current
     * summary is shown, correctly labelled as current, in the memory library.
     */
    const storedSummary = (provenance.summary && typeof provenance.summary === "object" ? provenance.summary : null) as Record<string, unknown> | null;

    let scene: { available: boolean; fields?: ReturnType<typeof sceneFieldsOf> } = { available: false };
    if (provenance.sceneStateId) {
      const sceneResult = await client.query(
        "SELECT * FROM conversation_scene_states WHERE id=$1 AND user_id=$2",
        [String(provenance.sceneStateId), account.id],
      );
      if (sceneResult.rowCount) scene = { available: true, fields: sceneFieldsOf(sceneStateFromRow(sceneResult.rows[0])) };
    }

    let scores: unknown[] = [];
    if (diagnostics && provenance.retrievalRunId) {
      const runResult = await client.query(
        "SELECT score_details,semantic_available,fallback_reason,total_stored_memories,core_canon_tokens,retrieved_episodic_tokens,arc_tokens,latency_ms FROM memory_retrieval_runs WHERE id=$1 AND user_id=$2",
        [String(provenance.retrievalRunId), account.id],
      );
      if (runResult.rowCount) scores = [runResult.rows[0]];
    }

    return {
      items,
      transcript,
      scene,
      summary: storedSummary
        ? { recorded: true as const, used: Boolean(storedSummary.used), characters: Number(storedSummary.characters || 0) }
        : { recorded: false as const },
      counts: {
        memories: message.memoryIds.length,
        arcs: message.arcIds.length,
        canon: canonIds.length,
        unavailable: items.filter((item) => !item.available).length,
        total: items.length,
      },
      ...(diagnostics ? { diagnostics: scores } : {}),
    };
  });

  if (!payload) return Response.json({ error: "Message not found" }, { status: 404 });
  return Response.json(payload);
}
