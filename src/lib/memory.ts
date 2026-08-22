import { randomUUID } from "node:crypto";
import { completionWithUsage, parseJson } from "./llm";
import { asUser, getUserSettings } from "./db";
import { consolidationPrompt } from "./prompts";
import type { Memory, MemoryArc, Message } from "./types";
import { memoryArcFromRow, memoryFromRow, messageFromRow } from "./db";
import { recordUsageEvent } from "./usage";
import { estimateTokens } from "./context";
import { providerModelId, taskModelSelection } from "./provider";
import { acquireMemoryJobLease, releaseMemoryJobLease } from "./memory-jobs";
import { memoryRetrievalV2Enabled } from "./memory-flags";
import type { PoolClient } from "pg";

const stopWords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "are", "was", "for", "but", "not", "they", "she", "him", "her", "his", "our"]);
const essentialKinds = new Set<Memory["kind"]>(["relationship", "promise", "boundary", "open_loop"]);
const protectedKinds = new Set<Memory["kind"]>(["promise", "boundary", "open_loop"]);
const activeConsolidations = new Set<string>();

/**
 * The newest assistant reply remains provisional while the user can regenerate
 * or choose another variant. It becomes accepted only when the story advances.
 */
export function acceptedMessageCount(messageCount: number, latestRole?: Message["role"] | null) {
  return Math.max(0,messageCount - (latestRole === "assistant" ? 1 : 0));
}

export async function invalidateDerivedContinuity(client: PoolClient, conversationId: string, validThroughPosition: number, userId?: string) {
  const position = Math.max(0,validThroughPosition);
  const owner = userId ?? null;
  await client.query("DELETE FROM memories WHERE conversation_id=$1 AND source_message_count > $2 AND ($3::uuid IS NULL OR user_id=$3)",[conversationId,position,owner]);
  await client.query("DELETE FROM memory_arcs WHERE conversation_id=$1 AND end_message_count > $2 AND ($3::uuid IS NULL OR user_id=$3)",[conversationId,position,owner]);
  const v2Enabled=Boolean(userId&&memoryRetrievalV2Enabled(userId));
  if (v2Enabled) {
    // Canon is derived from the permanent archive. A branch/edit supersedes
    // only canon whose evidence came from the discarded future.
    await client.query("UPDATE core_canon_entries SET status='superseded',updated_at=now() WHERE conversation_id=$1 AND source_message_count>$2 AND user_id=$3",[conversationId,position,userId]);
  }
  const countResult = await client.query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[conversationId]);
  const messageCount = Number(countResult.rows[0].count);
  if (v2Enabled) await client.query(
    "UPDATE conversations SET message_count=$1,summary='',last_consolidated_count=$2,last_curated_message_count=LEAST(last_curated_message_count,$5),canon_version=canon_version+1,updated_at=now() WHERE id=$3 AND user_id=$4",
    [messageCount,Math.max(0,messageCount - 50),conversationId,userId,position],
  );
  else await client.query(
    "UPDATE conversations SET message_count=$1,summary='',last_consolidated_count=$2,updated_at=now() WHERE id=$3 AND ($4::uuid IS NULL OR user_id=$4)",
    [messageCount,Math.max(0,messageCount - 50),conversationId,owner],
  );
}

function terms(value: string) {
  const words = value.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
  return new Set(words.filter((word) => !stopWords.has(word)).map((word) => {
    if (word.length > 6 && word.endsWith("ing")) return word.slice(0, -3);
    if (word.length > 5 && word.endsWith("ed")) return word.slice(0, -2);
    if (word.length > 5 && word.endsWith("es")) return word.slice(0, -2);
    if (word.length > 4 && word.endsWith("s")) return word.slice(0, -1);
    return word;
  }));
}

function memoryCost(memory: Memory) {
  return estimateTokens(`${memory.content} ${memory.resolution}`) + 16;
}

export function rankMemories(memories: Memory[], input: string, limit = 8, tokenBudget = 6000) {
  const inputTerms = terms(input);
  const ranked = memories
    .map((memory) => {
      const memoryTerms = terms(`${memory.content} ${memory.keywords.join(" ")}`);
      let overlap = 0;
      inputTerms.forEach((term) => { if (memoryTerms.has(term)) overlap += 1; });
      const phraseHits = memory.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
      const ageDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / 86_400_000);
      const activeBoost = memory.status === "active" && protectedKinds.has(memory.kind) ? 18 : 0;
      const kindBoost = essentialKinds.has(memory.kind) ? 7 : memory.kind === "event" ? 2 : 0;
      const score = phraseHits * 24 + overlap * 5 + memory.importance * 3 + activeBoost + kindBoost + 2 / (1 + ageDays / 45);
      return { memory, score, overlap, phraseHits };
    })
    .filter(({ memory }) => memory.status !== "superseded")
    .sort((a, b) => b.score - a.score);

  const selected: Memory[] = [];
  const selectedIds = new Set<string>();
  let usedTokens = 0;
  const addWithinBudget = (memory: Memory) => {
    if (selectedIds.has(memory.id)) return false;
    const cost = memoryCost(memory);
    if (selected.length > 0 && usedTokens + cost > tokenBudget) return false;
    selected.push(memory); selectedIds.add(memory.id); usedTokens += cost; return true;
  };

  // Pinned journal entries are deliberate guarantees. Active promises,
  // boundaries, and open loops receive their own protected tier and do not
  // consume the ordinary relevant-event slot count.
  ranked.filter(({ memory }) => memory.pinned).forEach(({ memory }) => addWithinBudget(memory));
  const protectedTokenLimit = Math.max(500, Math.floor(tokenBudget * 0.55));
  let protectedTokens = 0;
  let protectedCount = 0;
  ranked
    .filter(({ memory }) => !memory.pinned && memory.status === "active" && protectedKinds.has(memory.kind))
    .forEach(({ memory }) => {
      const cost = memoryCost(memory);
      if (protectedCount >= 12 || (protectedCount > 0 && protectedTokens + cost > protectedTokenLimit)) return;
      if (addWithinBudget(memory)) { protectedCount += 1; protectedTokens += cost; }
    });
  const dynamic = ranked
    .filter(({ memory, overlap, phraseHits }) => !selectedIds.has(memory.id) && (
      memory.status === "active"
        ? phraseHits > 0 || overlap > 0 || memory.importance >= 4 || essentialKinds.has(memory.kind)
        : phraseHits > 0 || overlap > 0
    ));
  let dynamicCount = 0;
  for (const { memory } of dynamic) {
    if (dynamicCount >= limit) break;
    if (addWithinBudget(memory)) dynamicCount += 1;
  }
  return selected;
}

export function rankArcs(arcs: MemoryArc[], input: string, limit = 4, tokenBudget = 1800) {
  const inputTerms = terms(input);
  const ranked = arcs.map((arc) => {
    const arcTerms = terms(`${arc.summary} ${arc.keywords.join(" ")}`);
    let overlap = 0; inputTerms.forEach((term) => { if (arcTerms.has(term)) overlap += 1; });
    const phraseHits = arc.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
    const ageDays = Math.max(0, (Date.now() - new Date(arc.createdAt).getTime()) / 86_400_000);
    return { arc, score: phraseHits * 24 + overlap * 5 + 2 / (1 + ageDays / 90), overlap, phraseHits };
  }).filter(({ overlap, phraseHits }) => overlap > 0 || phraseHits > 0).sort((a,b) => b.score - a.score);
  const selected: MemoryArc[] = []; let used = 0;
  for (const { arc } of ranked) {
    const cost = estimateTokens(arc.summary) + 12;
    if (selected.length > 0 && used + cost > tokenBudget) continue;
    selected.push(arc); used += cost;
    if (selected.length >= limit) break;
  }
  return selected;
}

/**
 * Durable memories this account holds for a character.
 *
 * The `conversation_id IS NULL` arm is what makes a memory apply across every
 * chat with the same character. Without the account predicate it would also
 * apply across every *account* chatting with a shared public character, which
 * is why the owner filter is not optional here.
 */
export async function relevantMemories(client: PoolClient, userId: string, characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000) {
  const result = await client.query(
    "SELECT * FROM memories WHERE user_id = $3 AND character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY pinned DESC, created_at DESC",
    [characterId,conversationId,userId],
  );
  return rankMemories(result.rows.map(memoryFromRow), input, limit, tokenBudget);
}

export async function relevantContinuity(client: PoolClient, userId: string, characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000) {
  const arcBudget = Math.min(2000, Math.max(500, Math.floor(tokenBudget * 0.25)));
  const [memories, arcResult] = await Promise.all([
    relevantMemories(client,userId,characterId,conversationId,input,limit,Math.max(500,tokenBudget - arcBudget)),
    client.query("SELECT * FROM memory_arcs WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC",[conversationId,userId]),
  ]);
  const arcs = rankArcs(arcResult.rows.map(memoryArcFromRow),input,4,arcBudget);
  if (memories.length) await client.query(
    "UPDATE memories SET last_recalled_at=now(),recall_count=recall_count+1 WHERE id=ANY($1::uuid[]) AND user_id=$2",
    [memories.map((memory) => memory.id),userId],
  );
  return { memories, arcs };
}

type Consolidation = {
  summary?: string;
  arcSummary?: string;
  arcKeywords?: string[];
  memories?: Array<{ content?: string; kind?: Memory["kind"]; importance?: number; keywords?: string[] }>;
  memoryUpdates?: Array<{ id?: string; status?: "active" | "resolved"; resolution?: string }>;
};

function similarity(left: string, right: string) {
  const a = terms(left); const b = terms(right);
  if (!a.size || !b.size) return 0;
  let shared = 0; a.forEach((term) => { if (b.has(term)) shared += 1; });
  return shared / (a.size + b.size - shared);
}

/**
 * Condenses recent turns into the rolling summary, an episodic arc, and new
 * durable memories.
 *
 * Every statement runs as the owning account. The model call deliberately sits
 * between short transactions rather than inside one: a consolidation can take
 * several seconds and holding a pooled connection (and its locks) open across
 * a network round trip to the provider would stall other requests.
 */
export async function maybeConsolidate(userId: string, conversationId: string, force = false) {
  const lockKey = `${userId}:${conversationId}`;
  if (activeConsolidations.has(lockKey)) return false;
  activeConsolidations.add(lockKey);
  let databaseLease: string | null = null;
  try {
    if (memoryRetrievalV2Enabled(userId)) {
      databaseLease = await acquireMemoryJobLease(userId,conversationId,"consolidation",480);
      if (!databaseLease) return false;
    }
    const prepared = await asUser(userId, async (client) => {
      const settings = await getUserSettings(client, userId);
      const conversationResult = await client.query("SELECT * FROM conversations WHERE id = $1 AND user_id = $2", [conversationId, userId]);
      const conversation = conversationResult.rows[0];
      if (!conversation) return null;
      const messageCount = Number(conversation.message_count || 0);
      const latestResult = await client.query(
        "SELECT role FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
        [conversationId,userId],
      );
      const eligibleMessageCount = acceptedMessageCount(messageCount,latestResult.rows[0]?.role as Message["role"] | undefined);
      const previousCount = Number(conversation.last_consolidated_count || 0);
      const delta = eligibleMessageCount - previousCount;
      if (delta <= 0 || eligibleMessageCount < 2 || (!force && delta < settings.consolidationInterval)) return null;

      // Process the next unseen window rather than the newest 50 messages. If
      // maintenance ever falls behind, no older accepted turns are skipped.
      const batchSize = Math.min(50,delta);
      const batchEnd = previousCount + batchSize;
      const messageResult = await client.query(
        "SELECT * FROM messages WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at ASC,id ASC OFFSET $3 LIMIT $4",
        [conversationId,userId,previousCount,batchSize],
      );
      const messages = messageResult.rows.map(messageFromRow) as Message[];
      const activeResult = await client.query(
        "SELECT * FROM memories WHERE user_id=$3 AND character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) AND status='active' AND kind IN ('promise','open_loop','boundary') ORDER BY pinned DESC,importance DESC,created_at ASC",
        [conversation.character_id, conversationId, userId],
      );
      const allActiveCommitments = activeResult.rows.map(memoryFromRow);
      const activeCommitments = rankMemories(allActiveCommitments, `${conversation.summary || ""}\n${messages.map((message) => message.content).join("\n")}`, 0, 5000);
      return { settings, conversation, batchEnd, messages, activeCommitments };
    });
    if (!prepared) return false;
    const { settings, conversation, batchEnd, messages, activeCommitments } = prepared;
    const previousCount = Number(conversation.last_consolidated_count || 0);

    const { providerId,modelId } = taskModelSelection("memory_consolidation");
    const rpEngineId = String(conversation.rp_engine_id || settings.roleplayPreset);
    const response = await completionWithUsage({ providerId, modelId }, [
      { role: "system", content: "You are a precise continuity editor and episodic-memory curator. Output JSON only." },
      { role: "user", content: consolidationPrompt(String(conversation.summary), messages, settings.ownerName, activeCommitments) },
    ], { json: true, maxTokens: 3600, temperature: 0.2 });
    if (response.usage) await recordUsageEvent({ userId, conversationId, providerId, model: modelId, actualModel: providerModelId(providerId,modelId) ?? modelId, rpEngineId, kind: "memory_consolidation", taskRoute: "memory_consolidation", usage: response.usage });
    const data = parseJson<Consolidation>(response.content);
    if (!data.summary) return false;

    const createdRecords = await asUser(userId, async (client) => {
      const records: Array<{type:"memory"|"arc";id:string;content:string}> = [];
      await client.query(
        "UPDATE conversations SET summary = $1, last_consolidated_count = GREATEST(last_consolidated_count,$2), updated_at = now() WHERE id = $3 AND user_id = $4",
        [data.summary!.slice(0, 12000), batchEnd, conversationId, userId],
      );
      if (data.arcSummary?.trim()) {
        const arcId=randomUUID(); const arcContent=data.arcSummary.trim().slice(0,4000);
        await client.query(
          "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,keywords,start_message_count,end_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [arcId,conversationId,userId,arcContent,(data.arcKeywords ?? []).slice(0,12),previousCount + 1,batchEnd],
        );
        records.push({type:"arc",id:arcId,content:arcContent});
      }
      const updateableIds = new Set(activeCommitments.filter((memory) => memory.kind === "promise" || memory.kind === "open_loop").map((memory) => memory.id));
      for (const update of (data.memoryUpdates ?? []).slice(0,20)) {
        if (!update.id || !updateableIds.has(update.id) || !["active","resolved"].includes(String(update.status))) continue;
        const status = update.status as "active" | "resolved";
        const resolution = status === "resolved" ? String(update.resolution || "Resolved in the story.").slice(0,1000) : "";
        await client.query(
          "UPDATE memories SET status=$1,resolution=$2,resolved_at=CASE WHEN $1='resolved' THEN now() ELSE NULL END,updated_at=now() WHERE id=$3 AND user_id=$4",
          [status,resolution,update.id,userId],
        );
      }
      const existingResult = await client.query(
        "SELECT * FROM memories WHERE user_id=$3 AND character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY created_at DESC",
        [conversation.character_id,conversationId,userId],
      );
      const existing = existingResult.rows.map(memoryFromRow);
      const seenContent = existing.filter((memory) => !(memory.status === "resolved" && (memory.kind === "promise" || memory.kind === "open_loop"))).map((memory) => memory.content);
      const kinds: Memory["kind"][] = ["identity","relationship","event","promise","preference","boundary","open_loop"];
      for (const item of (data.memories ?? []).slice(0, 10)) {
        const content = item.content?.trim();
        if (!content || seenContent.some((stored) => similarity(stored, content) >= 0.72)) continue;
        const kind = kinds.includes(item.kind as Memory["kind"]) ? item.kind : "event";
        seenContent.push(content);
        const memoryId=randomUUID();
        await client.query(
          "INSERT INTO memories (id, character_id, conversation_id, user_id, content, kind, importance, keywords, source_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [memoryId, conversation.character_id, conversationId, userId, content.slice(0, 3000), kind, Math.min(5, Math.max(1, Number(item.importance) || 3)), (item.keywords ?? []).slice(0, 12), batchEnd],
        );
        records.push({type:"memory",id:memoryId,content:content.slice(0,3000)});
      }
      return records;
    });
    if (createdRecords.length) await import("./memory-v2").then(({embedContinuityRecords}) => embedContinuityRecords(userId,conversationId,createdRecords)).catch((error) => { console.error("New memory embedding failed",error); return false; });
    return true;
  } finally {
    if (databaseLease) await releaseMemoryJobLease(userId,conversationId,databaseLease).catch(() => undefined);
    activeConsolidations.delete(lockKey);
  }
}
