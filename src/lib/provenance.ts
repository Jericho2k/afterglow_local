import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/**
 * WHAT ONE GENERATION ACTUALLY READ, RECORDED SO IT STAYS TRUE.
 *
 * The product promise behind the Context inspector is narrow and absolute:
 * "this is the exact story context the writer had when THIS variant was
 * produced". Three things were quietly falsifying it.
 *
 * REGENERATE PUT SEVERAL GENERATIONS ON ONE ROW. Every attempt is another
 * variant of the same message, and the provenance columns on that message were
 * overwritten by whichever attempt ran last. Ask about option 1 of 3 and you
 * were shown option 3's memories. `message_generations` is one immutable row
 * per generation, unique on (message_id, variant_index).
 *
 * MEMORY TEXT IS MUTABLE. A reader who rewords a memory today changes what
 * every past reply appears to have read. So a generation records the memory
 * VERSION it was handed, not just the id.
 *
 * TRANSCRIPT TEXT IS MUTABLE TOO. The inline editor rewrites message content in
 * place, so ids alone could never reconstruct the turns a writer was given.
 * Same fix.
 *
 * Continue is deliberately untouched. It creates a NEW assistant message rather
 * than another variant of the old one — verified in the chat route, where a
 * regeneration target is only ever resolved for `action === "regenerate"` — so
 * its generation is simply variant 0 of a new row.
 */

/** A reference to one exact version of a mutable row. */
export type VersionRef = { id: string; v: number };

export type GenerationRecord = {
  messageId: string;
  conversationId: string;
  userId: string;
  variantIndex: number;
  action: "send" | "regenerate" | "continue";
  memoryVersions: VersionRef[];
  transcriptVersions: VersionRef[];
  arcIds: string[];
  canonIds: string[];
  sceneStateId: string | null;
  retrievalRunId: string | null;
  transcriptMessages: number;
  transcriptTokens: number;
  transcriptTrimmed: number;
  summaryUsed: boolean;
  summaryCharacters: number;
  continuityPlacement: string;
};

/**
 * Records a generation.
 *
 * Idempotent on (message_id, variant_index): a retry writes the same row rather
 * than a second one, and a row that already exists is NOT overwritten. That
 * asymmetry is the point — provenance is a statement about something that has
 * already happened, and nothing later is entitled to revise it.
 */
export async function recordGeneration(client: PoolClient, record: GenerationRecord) {
  await client.query(
    `INSERT INTO message_generations
     (id,message_id,conversation_id,user_id,variant_index,action,memory_versions,transcript_versions,
      arc_ids,canon_ids,scene_state_id,retrieval_run_id,transcript_messages,transcript_tokens,
      transcript_trimmed,summary_used,summary_characters,continuity_placement)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::uuid[],$10::uuid[],$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (message_id,variant_index) DO NOTHING`,
    [
      randomUUID(), record.messageId, record.conversationId, record.userId, record.variantIndex, record.action,
      JSON.stringify(record.memoryVersions), JSON.stringify(record.transcriptVersions),
      record.arcIds, record.canonIds, record.sceneStateId, record.retrievalRunId,
      record.transcriptMessages, record.transcriptTokens, record.transcriptTrimmed,
      record.summaryUsed, record.summaryCharacters, record.continuityPlacement,
    ],
  );
}

/** The generation that produced one stored variant, or null for a legacy reply. */
export async function generationFor(client: PoolClient, userId: string, messageId: string, variantIndex: number) {
  const result = await client.query(
    "SELECT * FROM message_generations WHERE user_id=$1 AND message_id=$2 AND variant_index=$3",
    [userId, messageId, variantIndex],
  );
  return result.rowCount ? generationFromRow(result.rows[0]) : null;
}

export function generationFromRow(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    variantIndex: Number(row.variant_index || 0),
    action: String(row.action || "send"),
    memoryVersions: versionRefs(row.memory_versions),
    transcriptVersions: versionRefs(row.transcript_versions),
    arcIds: textArray(row.arc_ids),
    canonIds: textArray(row.canon_ids),
    sceneStateId: row.scene_state_id ? String(row.scene_state_id) : null,
    retrievalRunId: row.retrieval_run_id ? String(row.retrieval_run_id) : null,
    transcriptMessages: Number(row.transcript_messages || 0),
    transcriptTokens: Number(row.transcript_tokens || 0),
    transcriptTrimmed: Number(row.transcript_trimmed || 0),
    summaryUsed: Boolean(row.summary_used),
    summaryCharacters: Number(row.summary_characters || 0),
    continuityPlacement: String(row.continuity_placement || ""),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : null,
  };
}

/**
 * How a supplied item stands today, relative to what the generation was given.
 *
 * These are the only four honest answers, and "not recorded" is one of them.
 * A generation from before this table existed cannot have its context
 * reconstructed — the transcript window has moved, canon has been re-curated,
 * the summary has been overwritten — and inventing one would be exactly the
 * confident lie this whole file exists to remove.
 */
export type HistoricalState = "as_supplied" | "edited_since" | "removed_since" | "not_recorded";

/**
 * Resolves one recorded version reference against the rows as they stand now.
 *
 * A version equal to the parent's current counter IS the parent's own text.
 * Anything lower was archived by the edit that replaced it. A reference to a
 * version with neither is a row that has been purged outright, which is the one
 * case where the text is genuinely gone and says so.
 */
export function resolveVersion(
  reference: VersionRef,
  current: { contentVersion: number; content: string; removed?: boolean } | undefined,
  archived: Map<string, { content: string }>,
): { content: string | null; state: HistoricalState } {
  if (!current) {
    const older = archived.get(versionKey(reference));
    return older ? { content: older.content, state: "removed_since" } : { content: null, state: "removed_since" };
  }
  if (reference.v >= current.contentVersion) {
    return { content: current.content, state: current.removed ? "removed_since" : "as_supplied" };
  }
  const older = archived.get(versionKey(reference));
  return older
    ? { content: older.content, state: "edited_since" }
    // The version was recorded but its archived text is missing: an explicit
    // purge is the only path that removes one. Say so rather than showing the
    // current text as if it were what the writer read.
    : { content: null, state: "removed_since" };
}

export function versionKey(reference: VersionRef) {
  return `${reference.id}:${reference.v}`;
}

function versionRefs(value: unknown): VersionRef[] {
  const raw = typeof value === "string" ? safeParse(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (item && typeof item === "object" ? { id: String((item as Record<string, unknown>).id ?? ""), v: Number((item as Record<string, unknown>).v ?? 1) } : null))
    .filter((item): item is VersionRef => Boolean(item?.id) && Number.isFinite(item?.v));
}

function safeParse(value: string) {
  try { return JSON.parse(value); } catch { return null; }
}

function textArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value === "{}") return [];
  return value.replace(/^\{|\}$/g, "").split(",").map((item) => item.replace(/^"|"$/g, "").trim()).filter(Boolean);
}
