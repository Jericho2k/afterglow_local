import { randomUUID } from "node:crypto";
import { completionWithUsage, parseJson } from "./deepseek";
import { getSettings, query } from "./db";
import { consolidationPrompt } from "./prompts";
import type { Memory, Message } from "./types";
import { memoryFromRow, messageFromRow } from "./db";
import { recordUsageEvent } from "./usage";

const stopWords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "are", "was", "for", "but", "not", "they", "she", "him", "her", "his", "our"]);
const essentialKinds = new Set<Memory["kind"]>(["relationship", "promise", "boundary", "open_loop"]);
const activeConsolidations = new Set<string>();

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

export function rankMemories(memories: Memory[], input: string, limit = 8) {
  const inputTerms = terms(input);
  const ranked = memories
    .map((memory) => {
      const memoryTerms = terms(`${memory.content} ${memory.keywords.join(" ")}`);
      let overlap = 0;
      inputTerms.forEach((term) => { if (memoryTerms.has(term)) overlap += 1; });
      const phraseHits = memory.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
      const ageDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / 86_400_000);
      const kindBoost = essentialKinds.has(memory.kind) ? 7 : memory.kind === "event" ? 2 : 0;
      const score = phraseHits * 24 + overlap * 5 + memory.importance * 3 + kindBoost + 2 / (1 + ageDays / 45);
      return { memory, score, overlap, phraseHits };
    })
    .sort((a, b) => b.score - a.score);

  // Pinned items are a guarantee and do not consume the automatic-recall limit.
  const pinned = ranked.filter(({ memory }) => memory.pinned).map(({ memory }) => memory);
  const dynamic = ranked
    .filter(({ memory, overlap, phraseHits }) => !memory.pinned && (phraseHits > 0 || overlap > 0 || memory.importance >= 4 || essentialKinds.has(memory.kind)))
    .slice(0, limit)
    .map(({ memory }) => memory);
  return [...pinned, ...dynamic];
}

export async function relevantMemories(characterId: string, conversationId: string, input: string, limit = 8) {
  const result = await query(
    "SELECT * FROM memories WHERE character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY pinned DESC, created_at DESC LIMIT 300",
    [characterId,conversationId],
  );
  return rankMemories(result.rows.map(memoryFromRow), input, limit);
}

type Consolidation = { summary?: string; memories?: Array<{ content?: string; kind?: Memory["kind"]; importance?: number; keywords?: string[] }> };

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

    const batchSize = Math.min(50, Math.max(2, force ? messageCount : delta));
    const messageResult = await query(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2",
      [conversationId, batchSize],
    );
    const messages = messageResult.rows.reverse().map(messageFromRow) as Message[];
    const response = await completionWithUsage([
      { role: "system", content: "You are a precise continuity editor and episodic-memory curator. Output JSON only." },
      { role: "user", content: consolidationPrompt(String(conversation.summary), messages, settings.ownerName) },
    ], { json: true, maxTokens: 2400, temperature: 0.2, model: settings.model });
    if (response.usage) await recordUsageEvent({ conversationId, model: settings.model, kind: "memory_consolidation", usage: response.usage });
    const data = parseJson<Consolidation>(response.content);
    if (!data.summary) return false;

    await query(
      "UPDATE conversations SET summary = $1, last_consolidated_count = GREATEST(last_consolidated_count,$2), updated_at = now() WHERE id = $3",
      [data.summary.slice(0, 12000), messageCount, conversationId],
    );
    const existingResult = await query(
      "SELECT * FROM memories WHERE character_id = $1 AND (conversation_id = $2 OR conversation_id IS NULL) ORDER BY created_at DESC LIMIT 500",
      [conversation.character_id,conversationId],
    );
    const existing = existingResult.rows.map(memoryFromRow);
    const seenContent = existing.map((memory) => memory.content);
    const kinds: Memory["kind"][] = ["identity","relationship","event","promise","preference","boundary","open_loop"];
    for (const item of (data.memories ?? []).slice(0, 10)) {
      const content = item.content?.trim();
      if (!content || seenContent.some((stored) => similarity(stored, content) >= 0.72)) continue;
      const kind = kinds.includes(item.kind as Memory["kind"]) ? item.kind : "event";
      seenContent.push(content);
      await query(
        "INSERT INTO memories (id, character_id, conversation_id, content, kind, importance, keywords) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), conversation.character_id, conversationId, content.slice(0, 3000), kind, Math.min(5, Math.max(1, Number(item.importance) || 3)), (item.keywords ?? []).slice(0, 12)],
      );
    }
    return true;
  } finally {
    activeConsolidations.delete(conversationId);
  }
}
