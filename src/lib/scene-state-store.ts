import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { asUser, castMembersFromRow, getUserSettings, messageFromRow, sceneStateFromRow } from "./db";
import { completionWithUsage, parseJson } from "./llm";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "./memory-jobs";
import { sceneStateEnabled } from "./memory-flags";
import { providerModelId, taskModelSelection } from "./provider";
import { inferenceSessionId } from "./inference-session";
import {
  locationLabel, mergeSceneState, normalizeSceneUpdate, renderCurrentScene, sceneExtractionPrompt,
  sceneExtractionSystemPrompt, sceneFieldsOf, sceneIsEmpty, type SceneStateFields,
} from "./scene-state";
import { recordUsageEvent } from "./usage";
import { estimateTokens } from "./context";
import type { Message, SceneStamp } from "./types";

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

const transcriptWindow = 14;
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
  const state = sceneStateFromRow(result.rows[0]);
  const stamp: SceneStamp = {
    storyDay: state.storyDay,
    timeOfDay: state.timeOfDay,
    location: locationLabel(state.location),
    present: state.presentCharacters,
  };
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
  for (const row of result.rows.reverse()) {
    const state = sceneStateFromRow(row);
    const mappedId = state.throughMessageId ? input.messageMap.get(state.throughMessageId) ?? null : null;
    // A row whose message did not travel into the branch keeps its values but
    // loses its fingerprint anchor, so it stays usable without pretending to
    // describe a message this branch does not have.
    await client.query(
      `INSERT INTO conversation_scene_states
       (id,conversation_id,user_id,through_message_count,through_message_id,through_message_fingerprint,provisional,status,
        story_day,date_kind,date_text,time_of_day,time_text,location_place,location_sub,location_confidence,
        present_characters,active_situation,changed_fields,extraction_model,extraction_provider,extraction_latency_ms,
        failure_reason,token_count,version,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
      [
        randomUUID(), input.conversationId, input.userId, state.throughMessageCount, mappedId, mappedId ? state.throughMessageFingerprint : "",
        state.status, state.storyDay, state.dateKind, state.dateText, state.timeOfDay, state.timeText,
        state.location.place, state.location.sub, state.location.confidence,
        state.presentCharacters, state.activeSituation, state.changedFields,
        state.extractionModel, state.extractionProvider, state.extractionLatencyMs, state.failureReason,
        state.tokenCount, state.version, row.created_at, row.updated_at,
      ],
    );
  }
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
        story_day,date_kind,date_text,time_of_day,time_text,location_place,location_sub,location_confidence,
        present_characters,active_situation,changed_fields,extraction_model,extraction_provider,extraction_latency_ms,
        failure_reason,token_count,version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ok',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,'',$22,$23)
       ON CONFLICT (conversation_id,through_message_count) DO UPDATE SET
         through_message_id=EXCLUDED.through_message_id,through_message_fingerprint=EXCLUDED.through_message_fingerprint,
         provisional=EXCLUDED.provisional,status='ok',story_day=EXCLUDED.story_day,date_kind=EXCLUDED.date_kind,
         date_text=EXCLUDED.date_text,time_of_day=EXCLUDED.time_of_day,time_text=EXCLUDED.time_text,
         location_place=EXCLUDED.location_place,location_sub=EXCLUDED.location_sub,location_confidence=EXCLUDED.location_confidence,
         present_characters=EXCLUDED.present_characters,active_situation=EXCLUDED.active_situation,
         changed_fields=EXCLUDED.changed_fields,extraction_model=EXCLUDED.extraction_model,
         extraction_provider=EXCLUDED.extraction_provider,extraction_latency_ms=EXCLUDED.extraction_latency_ms,
         failure_reason='',token_count=EXCLUDED.token_count,version=EXCLUDED.version,updated_at=now()`,
      [
        randomUUID(), input.conversationId, userId, input.throughMessageCount, input.throughMessageId, input.fingerprint, input.provisional,
        input.fields.storyDay, input.fields.dateKind, input.fields.dateText, input.fields.timeOfDay, input.fields.timeText,
        input.fields.location.place, input.fields.location.sub, input.fields.location.confidence,
        input.fields.presentCharacters, input.fields.activeSituation, input.changed,
        input.model, input.provider, input.latencyMs, tokens, input.version,
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

function transcriptFor(messages: Message[], userLabel: string) {
  return messages.map((message) => `${message.role === "user" ? userLabel : "Story"}: ${message.content.replace(/\s+/g, " ").slice(0, 1600)}`).join("\n\n");
}

/**
 * Brings the scene ledger up to the newest message.
 *
 * Runs in the background after a reply, never on the request path, and never
 * throws: a chat that cannot update its scene keeps the last state it had.
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
        [conversationId, userId, force ? Math.max(0, total - transcriptWindow) : from, force ? transcriptWindow : Math.max(1, total - from)],
      );
      const window = windowResult.rows.map(messageFromRow).slice(-transcriptWindow);
      if (!window.length) return null;
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
        conversation, total, previous, window, userLabel,
        knownNames: [...new Set(names)].slice(0, 24),
        premise: String(characterRow.scenario || "").slice(0, 1200),
      };
    });
    if (!prepared) return false;

    position = prepared.total;
    const newest = prepared.window[prepared.window.length - 1];
    const previousFields = sceneFieldsOf(prepared.previous);
    selection = taskModelSelection("scene_state");
    const model = providerModelId(selection.providerId, selection.modelId) ?? selection.modelId;

    try {
      const response = await completionWithUsage(selection, [
        { role: "system", content: sceneExtractionSystemPrompt() },
        {
          role: "user",
          content: sceneExtractionPrompt({
            previous: previousFields,
            transcript: transcriptFor(prepared.window, prepared.userLabel),
            knownNames: prepared.knownNames,
            premise: prepared.premise,
            isOpening: sceneIsEmpty(previousFields),
          }),
        },
      ], {
        json: true, maxTokens: 600, temperature: 0.1,
        // Scene extraction is conversation-shaped too — a stable instruction
        // prefix over a growing transcript — so it gets its own sticky
        // namespace. Deliberately not the roleplay one: the two prompts share
        // no prefix, and pooling them would ask a provider to hold a cache
        // that could never hit.
        sessionId: inferenceSessionId("scene_state", conversationId),
      });
      const latencyMs = Math.max(0, Date.now() - started);
      if (response.usage) {
        await recordUsageEvent({
          userId, conversationId, providerId: selection.providerId, model: selection.modelId, actualModel: model,
          rpEngineId: String(prepared.conversation.rp_engine_id || "immersive"),
          kind: "scene_state", taskRoute: "scene_state_update",
          usage: { ...response.usage, latency_ms: latencyMs, actual_model: model },
        }).catch((error) => console.error("Scene State usage accounting failed", error));
      }
      const merged = mergeSceneState(previousFields, normalizeSceneUpdate(parseJson(response.content)));
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
      console.error("Scene State extraction failed", error);
      await writeSceneFailure(userId, conversationId, position, reason, selection.modelId, selection.providerId, Math.max(0, Date.now() - started));
      return false;
    }
  } catch (error) {
    // Nothing here may reach the chat route: the reply has already been sent.
    console.error("Scene State update failed", error);
    return false;
  } finally {
    await releaseMemoryJobLease(userId, conversationId, lease).catch(() => undefined);
  }
}
