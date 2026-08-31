import type { PoolClient } from "pg";
import { asUser, coreCanonFromRow, memoryArcFromRow, memoryFromRow, messageFromRow, sceneStateFromRow } from "@/lib/db";
import { generationFor, resolveVersion, versionKey, type VersionRef } from "@/lib/provenance";
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
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const account = await currentAccount();
  if (!account) return unauthorized();
  const { id } = await context.params;
  const diagnostics = isAdminAccount(account);
  const requestedVariant = Number.parseInt(new URL(request.url).searchParams.get("variant") ?? "", 10);

  const payload = await asUser(account.id, async (client) => {
    const messageResult = await client.query("SELECT * FROM messages WHERE id=$1 AND user_id=$2", [id, account.id]);
    if (!messageResult.rowCount) return null;
    const row = messageResult.rows[0];
    const message = messageFromRow(row);
    const provenance = (row.context_provenance && typeof row.context_provenance === "object" ? row.context_provenance : {}) as Record<string, unknown>;

    /*
     * WHICH GENERATION IS BEING ASKED ABOUT.
     *
     * Regenerate keeps every attempt as a variant of this one row, and the
     * columns on the row only ever described whichever attempt ran last. So the
     * question "what did option 1 of 3 read" has to be answered from the
     * generation record for THAT variant, not from the message.
     *
     * Defaults to the variant currently selected, which is the one on screen.
     */
    const variantIndex = Number.isInteger(requestedVariant) && requestedVariant >= 0 && requestedVariant < Math.max(1, message.variants.length)
      ? requestedVariant
      : message.selectedVariant;
    const generation = await generationFor(client, account.id, message.id, variantIndex);

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
    /*
     * Prefer the generation record; fall back to the message's denormalised
     * columns for a reply written before generations were recorded.
     *
     * The fallback is deliberately NOT a reconstruction. It reports the ids the
     * message carried, which describe the currently-selected variant and were
     * always true of it, and it reports the versioned parts as unrecorded rather
     * than resolving today's text and calling it history.
     */
    const memoryRefs = generation ? generation.memoryVersions : message.memoryIds.map((memoryId) => ({ id: memoryId, v: 0 }));
    const arcIds = generation ? generation.arcIds : message.arcIds;
    const canonIds = generation
      ? generation.canonIds.slice(0, 40)
      : Array.isArray(provenance.canonIds) ? provenance.canonIds.map(String).slice(0, 40) : [];
    const memories = { rows: await byIds("memories", memoryRefs.map((reference) => reference.id)) };
    const arcs = { rows: await byIds("memory_arcs", arcIds) };
    const canon = { rows: await byIds("core_canon_entries", canonIds) };

    /*
     * The archived text of any recorded version that has since been replaced.
     *
     * Only versions BELOW a row's current counter can be in the archive, so the
     * lookup is skipped entirely for the ordinary case where nothing has been
     * edited — which is almost every reply.
     */
    const archivedMemories = await archivedVersions(client, account.id, "memory_versions", "memory_id", memoryRefs.filter((reference) => {
      const current = memories.rows.find((item) => String(item.id) === reference.id);
      return Boolean(current) && reference.v > 0 && reference.v < Number(current!.content_version || 1);
    }));

    const memoryById = new Map(memories.rows.map((item) => [String(item.id), memoryFromRow(item)]));
    const arcById = new Map(arcs.rows.map((item) => [String(item.id), memoryArcFromRow(item)]));
    const canonById = new Map(canon.rows.map((item) => [String(item.id), coreCanonFromRow(item)]));

    // Stored order is recall order, and every stored id produces exactly one
    // item — present or not. That equality is the whole fix.
    const items = [
      ...memoryRefs.map((reference) => {
        const memory = memoryById.get(reference.id);
        const current = memories.rows.find((item) => String(item.id) === reference.id);
        /*
         * HOW THIS MEMORY STANDS RELATIVE TO WHAT THE WRITER WAS GIVEN.
         *
         * `as supplied` — unchanged since. `edited since` — the reader reworded
         * it, and the text below is the ORIGINAL, resolved from the archive.
         * `removed since` — superseded or purged. `not recorded` — a reply from
         * before generations were recorded, where the version is genuinely
         * unknown and guessing would be the lie this whole change removes.
         */
        const historical = reference.v === 0 || !current
          ? { content: memory?.content ?? null, state: reference.v === 0 ? "not_recorded" as const : "removed_since" as const }
          : resolveVersion(reference, {
            contentVersion: Number(current.content_version || 1),
            content: String(current.content),
            removed: String(current.status) === "superseded",
          }, archivedMemories);
        return memory || historical.content !== null
          ? {
            kind: "memory" as const, id: reference.id, available: true as const,
            content: historical.content ?? memory?.content ?? "",
            historicalState: historical.state,
            memoryKind: memory?.kind ?? "event", status: memory?.status ?? "superseded",
            importance: memory?.importance ?? 3, resolution: memory?.resolution ?? "",
            origin: memory?.origin ?? "consolidation",
            scope: memory?.conversationId ? ("chat" as const) : ("creation" as const),
          }
          : { kind: "memory" as const, id: reference.id, available: false as const, historicalState: historical.state };
      }),
      ...arcIds.map((arcId) => {
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
    const transcript = generation
      ? {
        recorded: true as const,
        messages: generation.transcriptMessages,
        firstMessageId: generation.transcriptVersions[0]?.id ?? null,
        estimatedTokens: generation.transcriptTokens,
        trimmedToFit: generation.transcriptTrimmed,
        /*
         * The exact turns, each resolved to the revision the writer was given.
         *
         * Message content is mutable, so an id on its own answers "what does
         * that turn say now" rather than "what did this reply read". A turn the
         * reader has since edited is shown as it WAS, marked `edited_since`.
         */
        turns: await resolvedTurns(client, account.id, generation.transcriptVersions),
      }
      : storedTranscript
        ? {
          recorded: true as const,
          messages: Number(storedTranscript.messages || 0),
          firstMessageId: storedTranscript.firstMessageId ? String(storedTranscript.firstMessageId) : null,
          estimatedTokens: Number(storedTranscript.estimatedTokens || 0),
          trimmedToFit: Number(storedTranscript.trimmedToFit || 0),
          turns: [] as Array<{ id: string; role: string; content: string; historicalState: string }>,
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
    const sceneStateId = generation?.sceneStateId ?? (provenance.sceneStateId ? String(provenance.sceneStateId) : null);
    if (sceneStateId) {
      const sceneResult = await client.query(
        "SELECT * FROM conversation_scene_states WHERE id=$1 AND user_id=$2",
        [sceneStateId, account.id],
      );
      if (sceneResult.rowCount) scene = { available: true, fields: sceneFieldsOf(sceneStateFromRow(sceneResult.rows[0])) };
    }

    let scores: unknown[] = [];
    const retrievalRunId = generation?.retrievalRunId ?? (provenance.retrievalRunId ? String(provenance.retrievalRunId) : null);
    if (diagnostics && retrievalRunId) {
      const runResult = await client.query(
        "SELECT score_details,semantic_available,fallback_reason,total_stored_memories,core_canon_tokens,retrieved_episodic_tokens,arc_tokens,latency_ms FROM memory_retrieval_runs WHERE id=$1 AND user_id=$2",
        [retrievalRunId, account.id],
      );
      if (runResult.rowCount) scores = [runResult.rows[0]];
    }

    return {
      items,
      transcript,
      scene,
      summary: generation
        ? { recorded: true as const, used: generation.summaryUsed, characters: generation.summaryCharacters }
        : storedSummary
          ? { recorded: true as const, used: Boolean(storedSummary.used), characters: Number(storedSummary.characters || 0) }
          : { recorded: false as const },
      variantIndex,
      variants: Math.max(1, message.variants.length),
      /*
       * Whether this variant's context was recorded at all.
       *
       * A reply written before generations existed says so, once, rather than
       * having every field quietly describe the newest attempt.
       */
      provenanceRecorded: Boolean(generation),
      counts: {
        memories: memoryRefs.length,
        arcs: arcIds.length,
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

/**
 * The archived text for a set of superseded version references.
 *
 * Only versions below a row's current counter were ever archived, so the caller
 * filters to those first and this does nothing at all in the ordinary case
 * where the reader has edited nothing.
 */
async function archivedVersions(client: PoolClient, userId: string, table: "memory_versions" | "message_versions", column: "memory_id" | "message_id", references: VersionRef[]) {
  const found = new Map<string, { content: string; role?: string }>();
  if (!references.length) return found;
  for (const reference of references.slice(0, 80)) {
    const result = await client.query(
      `SELECT * FROM ${table} WHERE user_id=$1 AND ${column}=$2 AND version=$3`,
      [userId, reference.id, reference.v],
    );
    if (result.rowCount) found.set(versionKey(reference), { content: String(result.rows[0].content), role: result.rows[0].role ? String(result.rows[0].role) : undefined });
  }
  return found;
}

/**
 * The transcript turns a generation was given, each at the revision it was given.
 *
 * The reader is looking at today's transcript, so a turn they have since edited
 * would otherwise silently claim the writer read the new wording. Bounded by the
 * writer's own context limit, which is what bounds the recorded list.
 */
async function resolvedTurns(client: PoolClient, userId: string, references: VersionRef[]) {
  if (!references.length) return [];
  const bounded = references.slice(0, 120);
  const placeholders = bounded.map((_reference, index) => `$${index + 2}`).join(",");
  const rows = await client.query(
    `SELECT id,role,content,content_version FROM messages WHERE user_id=$1 AND id IN (${placeholders})`,
    [userId, ...bounded.map((reference) => reference.id)],
  );
  const current = new Map(rows.rows.map((item) => [String(item.id), item]));
  const stale = bounded.filter((reference) => {
    const item = current.get(reference.id);
    return Boolean(item) && reference.v < Number(item.content_version || 1);
  });
  const archived = await archivedVersions(client, userId, "message_versions", "message_id", stale);

  return bounded.map((reference) => {
    const item = current.get(reference.id);
    const resolved = resolveVersion(reference, item ? { contentVersion: Number(item.content_version || 1), content: String(item.content) } : undefined, archived);
    return {
      id: reference.id,
      role: item ? String(item.role) : (archived.get(versionKey(reference))?.role ?? "assistant"),
      content: resolved.content ?? "",
      historicalState: resolved.state,
    };
  });
}
