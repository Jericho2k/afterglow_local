import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asUser, castMembersFromRow, getUserSettings, messageFromRow, sceneStateFromRow } from "./db";
import { completionWithUsage, parseJson } from "./llm";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "./memory-jobs";
import { sceneStateEnabled } from "./memory-flags";
import { backgroundReasoningFor, providerModelId } from "./provider";
import { backgroundRoute, routeProvenance } from "./background-routing";
import { inferenceSessionId } from "./inference-session";
import {
  mergeSceneState, normalizeSceneUpdate, renderCurrentScene, sceneExtractionPrompt,
  locationLabel, sceneExtractionSystemPrompt, sceneFieldsOf, sceneIsEmpty, sceneStampOf,
  sceneUpdateSkippable, type SceneStateFields,
} from "./scene-state";
import { recordUsageEvent } from "./usage";
import { estimateTokens } from "./context";
import type { Message, SceneStamp } from "./types";
import { insertValueRows } from "./sql-values";

/**
 * Persistence and maintenance for Scene State.
 *
 * Lineage is the integer message position that `memories.source_message_count`
 * already uses, so a branch copies scene rows exactly the way it copies
 * memories, and an edit or rewind invalidates them through the same call. No
 * second notion of "which history does this belong to" is introduced.
 *
 * The newest assistant reply is still replaceable, so the row derived through
 * it records a fingerprint of that reply. A regenerated or edited message no
 * longer matches its fingerprint and the row is ignored on read, which makes a
 * discarded generation unable to leave its scene behind even if cleanup never
 * runs.
 */

const retainedRowsPerConversation = 120;

export function sceneFingerprint(content: string) {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

type SceneRow = Record<string, unknown> & { through_content?: unknown };

function usableSceneRow(row: SceneRow) {
  const state = sceneStateFromRow(row);
  if (state.status !== "ok") return null;
  if (!state.throughMessageId || !state.throughMessageFingerprint) return state;
  const content = row.through_content;
  // The message this state was read out of is gone or has been rewritten:
  // whatever it said about the scene is no longer part of this story.
  if (typeof content !== "string") return null;
  return sceneFingerprint(content) === state.throughMessageFingerprint ? state : null;
}

/**
 * The scene the next reply happens in, or null when nothing is established.
 *
 * A handful of rows are read rather than one so a discarded newest generation
 * falls back to the last state that is still true instead of to nothing.
 */
export async function currentSceneState(client: PoolClient, userId: string, conversationId: string) {
  const result = await client.query(
    `SELECT s.*,m.content AS through_content
     FROM conversation_scene_states s
     LEFT JOIN messages m ON m.id=s.through_message_id AND m.user_id=s.user_id
     WHERE s.conversation_id=$1 AND s.user_id=$2 AND s.status='ok'
     ORDER BY s.through_message_count DESC LIMIT 6`,
    [conversationId, userId],
  );
  for (const row of result.rows as SceneRow[]) {
    const state = usableSceneRow(row);
    if (state) return state;
  }
  return null;
}

/** Latest row of any status, for admin diagnostics. */
export async function sceneStateHistory(client: PoolClient, userId: string, conversationId: string, limit = 12) {
  const result = await client.query(
    `SELECT s.*,m.content AS through_content
     FROM conversation_scene_states s
     LEFT JOIN messages m ON m.id=s.through_message_id AND m.user_id=s.user_id
     WHERE s.conversation_id=$1 AND s.user_id=$2
     ORDER BY s.through_message_count DESC,s.created_at DESC LIMIT $3`,
    [conversationId, userId, Math.min(50, Math.max(1, limit))],
  );
  return (result.rows as SceneRow[]).map((row) => ({ state: sceneStateFromRow(row), usable: Boolean(usableSceneRow(row)) }));
}

/**
 * The scene as it stood at a point in the past, used to stamp new memories.
 *
 * Approximate by construction: it is the last observation at or before the end
 * of the consolidated window, which is the closest grounded answer available
 * without paying for a second extraction per memory.
 */
export async function sceneStampAt(client: PoolClient, userId: string, conversationId: string, messageCount: number): Promise<SceneStamp | null> {
  const result = await client.query(
    `SELECT * FROM conversation_scene_states
     WHERE conversation_id=$1 AND user_id=$2 AND status='ok' AND through_message_count<=$3
     ORDER BY through_message_count DESC LIMIT 1`,
    [conversationId, userId, Math.max(0, messageCount)],
  );
  if (!result.rowCount) return null;
  const stamp: SceneStamp = sceneStampOf(sceneFieldsOf(sceneStateFromRow(result.rows[0])));
  return stamp.storyDay === null && !stamp.timeOfDay && !stamp.location && !stamp.present.length ? null : stamp;
}

/** The story-day span and places an arc's window passed through. */
export async function sceneSpanBetween(client: PoolClient, userId: string, conversationId: string, from: number, to: number) {
  const result = await client.query(
    `SELECT story_day,location_place,location_sub FROM conversation_scene_states
     WHERE conversation_id=$1 AND user_id=$2 AND status='ok' AND through_message_count>$3 AND through_message_count<=$4
     ORDER BY through_message_count ASC`,
    [conversationId, userId, Math.max(0, from), Math.max(0, to)],
  );
  const days = result.rows.map((row) => row.story_day).filter((day) => day != null).map(Number);
  const locations: string[] = [];
  for (const row of result.rows) {
    const label = locationLabel({ place: String(row.location_place || ""), sub: String(row.location_sub || ""), confidence: "unknown" });
    if (label && !locations.includes(label)) locations.push(label);
  }
  return {
    storyDayStart: days.length ? Math.min(...days) : null,
    storyDayEnd: days.length ? Math.max(...days) : null,
    locations: locations.slice(-4),
  };
}

/** Branch/edit/rewind: state derived from a discarded future is discarded too. */
export async function invalidateSceneStatesAfter(client: PoolClient, conversationId: string, validThroughPosition: number, userId?: string) {
  await client.query(
    "DELETE FROM conversation_scene_states WHERE conversation_id=$1 AND through_message_count>$2 AND ($3::uuid IS NULL OR user_id=$3)",
    [conversationId, Math.max(0, validThroughPosition), userId ?? null],
  );
}

/**
 * Regeneration: the state read out of the reply being replaced is dropped
 * before the replacement is written, so it can never survive the attempt that
 * produced it.
 */
export async function dropSceneStateForMessage(client: PoolClient, conversationId: string, messageId: string, userId: string) {
  await client.query(
    "DELETE FROM conversation_scene_states WHERE conversation_id=$1 AND user_id=$2 AND through_message_id=$3",
    [conversationId, userId, messageId],
  );
}

/** Copies the scene lineage a branch inherits, remapped onto its own messages. */
export async function copySceneStatesForBranch(
  client: PoolClient,
  input: { userId: string; sourceConversationId: string; conversationId: string; position: number; messageMap: Map<string, string> },
) {
  const result = await client.query(
    `SELECT * FROM conversation_scene_states
     WHERE conversation_id=$1 AND user_id=$2 AND through_message_count<=$3
     ORDER BY through_message_count DESC LIMIT 40`,
    [input.sourceConversationId, input.userId, Math.max(0, input.position)],
  );
  const rows: unknown[][] = [];
  for (const row of result.rows.reverse()) {
    const state = sceneStateFromRow(row);
    const mappedId = state.throughMessageId ? input.messageMap.get(state.throughMessageId) ?? null : null;
    // A row whose message did not travel into the branch keeps its values but
    // loses its fingerprint anchor, so it stays usable without pretending to
    // describe a message this branch does not have.
    rows.push([
      randomUUID(), input.conversationId, input.userId, state.throughMessageCount, mappedId,
      mappedId ? state.throughMessageFingerprint : "", false, state.status, state.storyDay,
      state.dateKind, state.dateText, timeOfDayColumn(state.time), state.time.text, state.time.kind,
      state.location.place, state.location.sub, state.location.confidence,
      // The branch inherits who was in the room at the branch point, positions
      // included, for the same reason it inherits the location: what happened
      // in the abandoned future is not true in this one.
      state.present.map((person) => person.name), JSON.stringify(state.present),
      state.changedFields, state.extractionModel, state.extractionProvider, state.extractionLatencyMs,
      state.failureReason, state.tokenCount, state.version, row.created_at, row.updated_at,
    ]);
  }
  await insertValueRows(client,
    `INSERT INTO conversation_scene_states
     (id,conversation_id,user_id,through_message_count,through_message_id,through_message_fingerprint,provisional,status,
      story_day,date_kind,date_text,time_of_day,time_text,time_kind,location_place,location_sub,location_confidence,
      present_characters,present_people,
      changed_fields,extraction_model,extraction_provider,extraction_latency_ms,
      failure_reason,token_count,version,created_at,updated_at) VALUES `,
    rows,
    { casts: { 18: "::jsonb" } },
  );
}

/**
 * The legacy `time_of_day` column, kept in step with the new time model.
 *
 * It is still what `sceneStampAt` and the memory stamp read on rows written by
 * earlier builds, and writing a sensible value into it keeps a mixed table
 * readable rather than half-blank. A relative time — "a few minutes later" — is
 * deliberately NOT written: it means nothing detached from the beat it was
 * measured from, and a memory tagged with it would be worse than one tagged
 * with nothing.
 */
function timeOfDayColumn(time: SceneStateFields["time"]) {
  return time.kind === "unknown" || time.kind === "relative" ? "" : time.text;
}

async function writeSceneRow(userId: string, input: {
  conversationId: string; throughMessageCount: number; throughMessageId: string | null; fingerprint: string;
  provisional: boolean; fields: SceneStateFields; changed: string[]; model: string; provider: string; latencyMs: number; version: number;
}) {
  const tokens = estimateTokens(renderCurrentScene(input.fields) || " ");
  await asUser(userId, async (client) => {
    await client.query(
      `INSERT INTO conversation_scene_states
       (id,conversation_id,user_id,through_message_count,through_message_id,through_message_fingerprint,provisional,status,
        story_day,date_kind,date_text,time_of_day,time_text,time_kind,location_place,location_sub,location_confidence,
        present_characters,present_people,
        changed_fields,extraction_model,extraction_provider,extraction_latency_ms,
        failure_reason,token_count,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ok',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20,$21,$22,'',$23,$24)
       ON CONFLICT (conversation_id,through_message_count) DO UPDATE SET
         through_message_id=EXCLUDED.through_message_id,through_message_fingerprint=EXCLUDED.through_message_fingerprint,
         provisional=EXCLUDED.provisional,status='ok',story_day=EXCLUDED.story_day,date_kind=EXCLUDED.date_kind,
         date_text=EXCLUDED.date_text,time_of_day=EXCLUDED.time_of_day,time_text=EXCLUDED.time_text,
         time_kind=EXCLUDED.time_kind,
         location_place=EXCLUDED.location_place,location_sub=EXCLUDED.location_sub,location_confidence=EXCLUDED.location_confidence,
         present_characters=EXCLUDED.present_characters,present_people=EXCLUDED.present_people,
         changed_fields=EXCLUDED.changed_fields,extraction_model=EXCLUDED.extraction_model,
         extraction_provider=EXCLUDED.extraction_provider,extraction_latency_ms=EXCLUDED.extraction_latency_ms,
         failure_reason='',token_count=EXCLUDED.token_count,version=EXCLUDED.version,updated_at=now()`,
      [
        randomUUID(), input.conversationId, userId, input.throughMessageCount, input.throughMessageId, input.fingerprint, input.provisional,
        input.fields.storyDay, input.fields.dateKind, input.fields.dateText,
        timeOfDayColumn(input.fields.time), input.fields.time.text, input.fields.time.kind,
        input.fields.location.place, input.fields.location.sub, input.fields.location.confidence,
        input.fields.present.map((person) => person.name), JSON.stringify(input.fields.present),
        input.changed, input.model, input.provider, input.latencyMs, tokens, input.version,
      ],
    );
    // One small row per accepted turn is cheap, but it is not free forever.
    await client.query(
      `DELETE FROM conversation_scene_states WHERE id IN (
         SELECT id FROM conversation_scene_states WHERE conversation_id=$1 AND user_id=$2
         ORDER BY through_message_count DESC OFFSET $3
       )`,
      [input.conversationId, userId, retainedRowsPerConversation],
    );
  });
}

/**
 * Records a failed extraction without touching the standing state.
 *
 * A failure must be visible in diagnostics and invisible everywhere else, so
 * the row is written only where no good state exists for that position and is
 * excluded from every read that feeds a prompt.
 */
async function writeSceneFailure(userId: string, conversationId: string, throughMessageCount: number, reason: string, model: string, provider: string, latencyMs: number) {
  await asUser(userId, (client) => client.query(
    `INSERT INTO conversation_scene_states
     (id,conversation_id,user_id,through_message_count,provisional,status,failure_reason,extraction_model,extraction_provider,extraction_latency_ms)
     VALUES ($1,$2,$3,$4,true,'failed',$5,$6,$7,$8)
     ON CONFLICT (conversation_id,through_message_count) DO NOTHING`,
    [randomUUID(), conversationId, userId, throughMessageCount, reason.slice(0, 400), model, provider, latencyMs],
  )).catch((error) => console.error("Scene State failure diagnostics could not be written", error));
}

/**
 * How much transcript the extractor reads.
 *
 * Far shorter than the fourteen messages the old physical extractor needed,
 * because the job is now smaller: detecting that the story moved, that time
 * passed, or that somebody arrived or left needs the messages in which those
 * things happened, and the ledger carried forward supplies everything before
 * them. A wide window was how the old prompt re-derived twelve limb positions
 * it had lost; nothing here has to be re-derived.
 */
const extractionWindow = 6;

function transcriptFor(messages: Message[], userLabel: string) {
  return messages.map((message) => `${message.role === "user" ? userLabel : "Story"}: ${message.content.replace(/\s+/g, " ").slice(0, 1200)}`).join("\n\n");
}

/**
 * One extraction attempt, parsed and schema-checked.
 *
 * "Schema-checked" is doing modest work: `normalizeSceneUpdate` already bounds
 * and discards everything malformed, so the only failures left are a reply that
 * is not JSON at all and a reply that parses to nothing usable. Both are real
 * on a very cheap model, and both are worth one cheap retry before the ledger
 * is simply carried forward.
 */
type ExtractionAttempt =
  | { ok: true; update: ReturnType<typeof normalizeSceneUpdate>; usage: Awaited<ReturnType<typeof completionWithUsage>>["usage"] }
  | { ok: false; reason: string; usage: Awaited<ReturnType<typeof completionWithUsage>>["usage"] };

async function extractOnce(
  selection: { providerId: string; modelId: string },
  messages: Parameters<typeof completionWithUsage>[1],
  sessionId: string | undefined,
): Promise<ExtractionAttempt> {
  const response = await completionWithUsage(selection, messages, {
    json: true, maxTokens: 400, temperature: 0.1,
    /*
     * The catalogue id, so the price ceiling and — on a request carrying a
     * reader's transcript — the privacy floor actually travel with it, and so
     * the adapter knows whether this endpoint implements `response_format`.
     *
     * The default extractor is Ling 3.0 Flash, which does NOT: it is asked for
     * JSON in words and its reply is parsed, bounded and retried on exactly the
     * path below. Sending the parameter to it anyway is what produced the run of
     * empty Scene Ledger extractions in production.
     */
    modelId: selection.modelId,
    /*
     * A 400-token envelope has no room for hidden thinking, and does not want
     * any: the whole reply is a handful of JSON fields. Ling declares no
     * reasoning support so this sends nothing at all for it; a DeepSeek or MiMo
     * ledger declines it explicitly. See `backgroundReasoningFor`.
     */
    thinking: backgroundReasoningFor(selection.modelId),
    strictReasoning: true,
    /*
     * Extraction is conversation-shaped: a stable instruction prefix over a
     * window that moves. Deliberately not the roleplay namespace — the two
     * prompts share no prefix, and pooling them would ask a provider to hold a
     * cache that could never hit.
     *
     * This is worth having and is NOT where the savings come from. The ledger
     * got cheap by running far less often, on a far smaller prompt, on a far
     * cheaper model; the cache is the fourth-largest of four effects and is
     * treated accordingly.
     */
    sessionId,
  });
  let parsed: unknown;
  try {
    parsed = parseJson(response.content);
  } catch {
    return { ok: false, reason: "reply was not valid JSON", usage: response.usage };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "reply was not a JSON object", usage: response.usage };
  return { ok: true, update: normalizeSceneUpdate(parsed), usage: response.usage };
}

/**
 * Brings the scene ledger up to the newest message.
 *
 * Runs in the background after a reply, never on the request path, and never
 * throws: a chat that cannot update its ledger keeps the last one it had. That
 * is also the failure path for a model that will not produce valid JSON, for a
 * disabled ledger, and for a skipped turn — one behaviour for four causes,
 * which is what makes the feature safe to make cheap.
 */
export async function maybeUpdateSceneState(userId: string, conversationId: string, force = false) {
  if (!sceneStateEnabled(userId)) return false;
  const lease = await acquireMemoryJobLease(userId, conversationId, "scene_state", 120);
  if (!lease) return false;
  let position = 0;
  let selection = { providerId: "", modelId: "" };
  const started = Date.now();
  try {
    const prepared = await asUser(userId, async (client) => {
      const conversation = (await client.query("SELECT * FROM conversations WHERE id=$1 AND user_id=$2", [conversationId, userId])).rows[0];
      if (!conversation) return null;
      const total = Number((await client.query("SELECT COUNT(*)::int count FROM messages WHERE conversation_id=$1 AND user_id=$2", [conversationId, userId])).rows[0]?.count || 0);
      if (!total) return null;
      const previous = await currentSceneState(client, userId, conversationId);
      const from = previous ? Math.min(previous.throughMessageCount, total) : 0;
      if (from >= total && !force) return null;
      const windowResult = await client.query(
        "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC OFFSET $3 LIMIT $4",
        [conversationId, userId, force ? Math.max(0, total - extractionWindow) : from, force ? extractionWindow : Math.max(1, total - from)],
      );
      const window = windowResult.rows.map(messageFromRow).slice(-extractionWindow);
      if (!window.length) return null;
      /*
       * WHAT IS ACTUALLY NEW, KEPT APART FROM WHAT THE EXTRACTOR READS.
       *
       * On the ordinary path these are the same messages — the query starts at
       * the last ledger position, so everything it returns is new. They come
       * apart on a FORCED run, where the window is taken from the end of the
       * conversation regardless of where the ledger stands, so that an
       * administrator asking "what does the extractor say about this scene" gets
       * an answer rather than an empty window.
       *
       * The distinction is kept because the skip decision must only ever weigh
       * genuinely new material: judging a turn static on the strength of a
       * message the ledger already read would be a heuristic firing on the
       * wrong evidence, and it would fire the same way every turn.
       */
      const unseen = previous ? window.slice(Math.max(0, window.length - Math.max(0, total - from))) : window;
      const settings = await getUserSettings(client, userId);
      const persona = conversation.persona_id
        ? (await client.query("SELECT name FROM personas WHERE id=$1 AND user_id=$2", [conversation.persona_id, userId])).rows[0]
        : null;
      const snapshot = conversation.character_snapshot as Record<string, unknown> | null;
      const characterRow = snapshot ?? (await client.query("SELECT name,cast_members,scenario FROM characters WHERE id=$1", [conversation.character_id])).rows[0] ?? {};
      const userLabel = String(persona?.name || settings.ownerName || "User");
      const names = [
        userLabel,
        String(characterRow.name || ""),
        ...castMembersFromRow(characterRow.cast_members ?? characterRow.cast).map((member) => member.name),
      ].map((name) => name.trim()).filter(Boolean);
      return {
        conversation, total, previous, window, unseen, userLabel,
        knownNames: [...new Set(names)].slice(0, 24),
        premise: String(characterRow.scenario || "").slice(0, 1200),
      };
    });
    if (!prepared) return false;

    position = prepared.total;
    const newest = prepared.window[prepared.window.length - 1];
    const previousFields = sceneFieldsOf(prepared.previous);

    /*
     * THE CHEAP GATE, BEFORE ANY MODEL IS ASKED ANYTHING.
     *
     * A forced run — the admin diagnostic — skips the gate, because the whole
     * point of forcing is to find out what the extractor says about a window
     * this heuristic would have waved through.
     */
    if (!force) {
      const decision = sceneUpdateSkippable(prepared.unseen, previousFields);
      if (decision.skip) {
        /*
         * Carried forward, not merely not-updated.
         *
         * The row is rewritten at the new position with the same values, which
         * is what makes the skip invisible to every reader of the ledger: the
         * next turn's `from` advances, the fingerprint anchors to the newest
         * reply, and a regenerated reply still invalidates it. Not writing
         * would leave the ledger pointing at an older message and re-examining
         * the same window forever.
         */
        await writeSceneRow(userId, {
          conversationId, throughMessageCount: prepared.total,
          throughMessageId: newest.id, fingerprint: sceneFingerprint(newest.content),
          provisional: newest.role === "assistant",
          fields: previousFields, changed: [],
          // Recorded as a skip rather than as an extraction by a model that
          // never ran, so the skip rate is readable straight off the ledger.
          model: "skipped", provider: "skipped", latencyMs: 0,
          version: (prepared.previous?.version ?? 0) + 1,
        });
        return true;
      }
    }

    /*
     * Which extractor, and whether there is one at all.
     *
     * `Disabled` is a real choice here: the route resolves to no selection and
     * the ledger simply stops advancing, keeping whatever it last held. That is
     * the same end state as a failed extraction, which is what makes turning
     * the feature off safe to do in production while a comparison runs.
     */
    const route = await backgroundRoute("scene_state", { overrideCandidateId: prepared.conversation.scene_model_override as string | null });
    if (!route.selection) return false;
    selection = route.selection;
    const model = providerModelId(selection.providerId, selection.modelId) ?? selection.modelId;
    const sessionId = inferenceSessionId("scene_state", conversationId);
    const request = [
      { role: "system" as const, content: sceneExtractionSystemPrompt() },
      {
        role: "user" as const,
        content: sceneExtractionPrompt({
          previous: previousFields,
          transcript: transcriptFor(prepared.window, prepared.userLabel),
          knownNames: prepared.knownNames,
          premise: prepared.premise,
          isOpening: sceneIsEmpty(previousFields),
        }),
      },
    ];

    try {
      let attempt = await extractOnce(selection, request, sessionId);
      let calls = 1;
      if (!attempt.ok) {
        /*
         * ONE RETRY, AND ONLY FOR A MALFORMED REPLY.
         *
         * A cheap model occasionally answers a JSON contract with prose, and a
         * second attempt usually fixes it for a fraction of a cent. A transport
         * failure is NOT retried here — the adapter already retries those
         * across hosts, and stacking a retry on a retry turns one bad minute
         * into four requests for a scene nobody is waiting on.
         */
        console.warn("[scene-ledger] retrying a malformed extraction", JSON.stringify({ conversationId, model, reason: attempt.reason }));
        if (attempt.usage) await recordSceneUsage(userId, conversationId, prepared, selection, model, route, attempt.usage, Date.now() - started);
        attempt = await extractOnce(selection, request, sessionId);
        calls = 2;
      }
      const latencyMs = Math.max(0, Date.now() - started);
      if (attempt.usage) await recordSceneUsage(userId, conversationId, prepared, selection, model, route, attempt.usage, latencyMs);
      if (!attempt.ok) {
        // Two malformed replies. The previous ledger stands, which is the same
        // outcome as a skip and a strictly better one than a guess.
        await writeSceneFailure(userId, conversationId, position, `${attempt.reason} (after ${calls} attempts)`, selection.modelId, selection.providerId, latencyMs);
        return false;
      }
      const merged = mergeSceneState(previousFields, attempt.update);
      await writeSceneRow(userId, {
        conversationId, throughMessageCount: prepared.total,
        throughMessageId: newest.id, fingerprint: sceneFingerprint(newest.content),
        provisional: newest.role === "assistant",
        fields: merged.fields, changed: merged.changed,
        model, provider: selection.providerId, latencyMs,
        version: (prepared.previous?.version ?? 0) + 1,
      });
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Scene extraction failed";
      console.error("Scene Ledger extraction failed", error);
      await writeSceneFailure(userId, conversationId, position, reason, selection.modelId, selection.providerId, Math.max(0, Date.now() - started));
      return false;
    }
  } catch (error) {
    // Nothing here may reach the chat route: the reply has already been sent.
    console.error("Scene Ledger update failed", error);
    return false;
  } finally {
    await releaseMemoryJobLease(userId, conversationId, lease).catch(() => undefined);
  }
}

/** Both attempts are billed, so both are recorded. */
async function recordSceneUsage(
  userId: string,
  conversationId: string,
  prepared: { conversation: Record<string, unknown> },
  selection: { providerId: string; modelId: string },
  model: string,
  route: Parameters<typeof routeProvenance>[0],
  usage: NonNullable<Awaited<ReturnType<typeof completionWithUsage>>["usage"]>,
  latencyMs: number,
) {
  await recordUsageEvent({
    userId, conversationId, providerId: selection.providerId, model: selection.modelId, actualModel: model,
    rpEngineId: String(prepared.conversation.rp_engine_id || "immersive"),
    kind: "scene_state", taskRoute: "scene_state_update",
    routing: routeProvenance(route),
    usage: { ...usage, latency_ms: latencyMs, actual_model: model },
  }).catch((error) => console.error("Scene Ledger usage accounting failed", error));
}
