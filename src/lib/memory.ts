import { randomUUID } from "node:crypto";
import { completionWithUsage, parseJson } from "./deepseek";
import { getSettings, query } from "./db";
import { consolidationPrompt } from "./prompts";
import type { Memory, MemoryArc, Message } from "./types";
import { memoryArcFromRow, memoryFromRow, messageFromRow } from "./db";
import { recordUsageEvent } from "./usage";
import { estimateTokens } from "./context";
import type { PoolClient } from "pg";

const stopWords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "are", "was", "for", "but", "not", "they", "she", "him", "her", "his", "our"]);
const essentialKinds = new Set<Memory["kind"]>(["relationship", "promise", "boundary", "open_loop"]);
const protectedKinds = new Set<Memory["kind"]>(["promise", "boundary", "open_loop"]);
const activeConsolidations = new Set<string>();

export async function invalidateDerivedContinuity(client: PoolClient, conversationId: string, validThroughPosition: number) {
  const position = Math.max(0,validThroughPosition);
  await client.query("DELETE FROM memories WHERE conversation_id=$1 AND source_message_count > $2",[conversationId,position]);
  await client.query("DELETE FROM memory_arcs WHERE conversation_id=$1 AND end_message_count > $2",[conversationId,position]);
  const countResult = await client.query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[conversationId]);
  const messageCount = Number(countResult.rows[0].count);
  await client.query(
    "UPDATE conversations SET message_count=$1,summary='',last_consolidated_count=$2,updated_at=now() WHERE id=$3",
    [messageCount,Math.max(0,messageCount - 50),conversationId],
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

export async function relevantMemories(characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000) {
  const result = await query(
    "SELECT * FROM memories WHERE character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY pinned DESC, created_at DESC",
    [characterId,conversationId],
  );
  return rankMemories(result.rows.map(memoryFromRow), input, limit, tokenBudget);
}

export async function relevantContinuity(characterId: string, conversationId: string, input: string, limit = 8, tokenBudget = 6000) {
  const arcBudget = Math.min(2000, Math.max(500, Math.floor(tokenBudget * 0.25)));
  const [memories, arcResult] = await Promise.all([
    relevantMemories(characterId,conversationId,input,limit,Math.max(500,tokenBudget - arcBudget)),
    query("SELECT * FROM memory_arcs WHERE conversation_id=$1 ORDER BY created_at DESC",[conversationId]),
  ]);
  const arcs = rankArcs(arcResult.rows.map(memoryArcFromRow),input,4,arcBudget);
  if (memories.length) await query(
    "UPDATE memories SET last_recalled_at=now(),recall_count=recall_count+1 WHERE id=ANY($1::uuid[])",
    [memories.map((memory) => memory.id)],
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

export async function maybeConsolidate(conversationId: string, force = false) {
  if (activeConsolidations.has(conversationId)) return false;
  activeConsolidations.add(conversationId);
  try {
    const settings = await getSettings();
    const conversationResult = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
    const conversation = conversationResult.rows[0];
    const messageCount = Number(conversation?.message_count || 0);
    const delta = messageCount - Number(conversation?.last_consolidated_count || 0);
    if (!conversation || (!force && delta < settings.consolidationInterval) || messageCount < 2) return false;

    const previousCount = Number(conversation.last_consolidated_count || 0);
    const batchSize = Math.min(50, Math.max(2, force ? (delta || settings.consolidationInterval) : delta));
    const messageResult = await query(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [conversationId, batchSize],
    );
    const messages = messageResult.rows.reverse().map(messageFromRow) as Message[];
    const activeResult = await query(
      "SELECT * FROM memories WHERE character_id=$1 AND (conversation_id=$2 OR conversation_id IS NULL) AND status='active' AND kind IN ('promise','open_loop','boundary') ORDER BY pinned DESC,importance DESC,created_at ASC",
      [conversation.character_id,conversationId],
    );
    const allActiveCommitments = activeResult.rows.map(memoryFromRow);
    const activeCommitments = rankMemories(allActiveCommitments,`${conversation.summary || ""}\n${messages.map((message) => message.content).join("\n")}`,0,5000);
    const response = await completionWithUsage([
      { role: "system", content: "You are a precise continuity editor and episodic-memory curator. Output JSON only." },
      { role: "user", content: consolidationPrompt(String(conversation.summary), messages, settings.ownerName, activeCommitments) },
    ], { json: true, maxTokens: 3600, temperature: 0.2, model: settings.model });
    if (response.usage) await recordUsageEvent({ conversationId, model: settings.model, kind: "memory_consolidation", usage: response.usage });
    const data = parseJson<Consolidation>(response.content);
    if (!data.summary) return false;

    await query(
      "UPDATE conversations SET summary = $1, last_consolidated_count = GREATEST(last_consolidated_count,$2), updated_at = now() WHERE id = $3",
      [data.summary.slice(0, 12000), messageCount, conversationId],
    );
    if (delta > 0 && data.arcSummary?.trim()) await query(
      "INSERT INTO memory_arcs (id,conversation_id,summary,keywords,start_message_count,end_message_count) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(),conversationId,data.arcSummary.trim().slice(0,4000),(data.arcKeywords ?? []).slice(0,12),Math.min(messageCount,previousCount + 1),messageCount],
    );
    const updateableIds = new Set(activeCommitments.filter((memory) => memory.kind === "promise" || memory.kind === "open_loop").map((memory) => memory.id));
    for (const update of (data.memoryUpdates ?? []).slice(0,20)) {
      if (!update.id || !updateableIds.has(update.id) || !["active","resolved"].includes(String(update.status))) continue;
      const status = update.status as "active" | "resolved";
      const resolution = status === "resolved" ? String(update.resolution || "Resolved in the story.").slice(0,1000) : "";
      await query(
        "UPDATE memories SET status=$1,resolution=$2,resolved_at=CASE WHEN $1='resolved' THEN now() ELSE NULL END,updated_at=now() WHERE id=$3",
        [status,resolution,update.id],
      );
    }
    const existingResult = await query(
      "SELECT * FROM memories WHERE character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY created_at DESC",
      [conversation.character_id,conversationId],
    );
    const existing = existingResult.rows.map(memoryFromRow);
    const seenContent = existing.filter((memory) => !(memory.status === "resolved" && (memory.kind === "promise" || memory.kind === "open_loop"))).map((memory) => memory.content);
    const kinds: Memory["kind"][] = ["identity","relationship","event","promise","preference","boundary","open_loop"];
    for (const item of (data.memories ?? []).slice(0, 10)) {
      const content = item.content?.trim();
      if (!content || seenContent.some((stored) => similarity(stored, content) >= 0.72)) continue;
      const kind = kinds.includes(item.kind as Memory["kind"]) ? item.kind : "event";
      seenContent.push(content);
      await query(
        "INSERT INTO memories (id, character_id, conversation_id, content, kind, importance, keywords, source_message_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), conversation.character_id, conversationId, content.slice(0, 3000), kind, Math.min(5, Math.max(1, Number(item.importance) || 3)), (item.keywords ?? []).slice(0, 12), messageCount],
      );
    }
    return true;
  } finally {
    activeConsolidations.delete(conversationId);
  }
}
