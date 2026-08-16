import { randomUUID } from "node:crypto";
import { completion, parseJson } from "./deepseek";
import { getSettings, query } from "./db";
import { consolidationPrompt } from "./prompts";
import type { Memory, Message } from "./types";
import { memoryFromRow, messageFromRow } from "./db";

const stopWords = new Set(["the", "and", "that", "this", "with", "from", "have", "your", "you", "are", "was", "for", "but", "not", "they", "she", "him", "her", "his", "our"]);

function terms(value: string) {
  return new Set(value.toLowerCase().match(/[\p{L}\p{N}']{3,}/gu)?.filter((word) => !stopWords.has(word)) ?? []);
}

export function rankMemories(memories: Memory[], input: string, limit = 8) {
  const inputTerms = terms(input);
  return memories
    .map((memory) => {
      const memoryTerms = terms(`${memory.content} ${memory.keywords.join(" ")}`);
      let overlap = 0;
      inputTerms.forEach((term) => { if (memoryTerms.has(term)) overlap += 1; });
      const phraseHits = memory.keywords.filter((key) => input.toLowerCase().includes(key.toLowerCase())).length;
      const ageDays = Math.max(0, (Date.now() - new Date(memory.createdAt).getTime()) / 86_400_000);
      const score = (memory.pinned ? 100 : 0) + phraseHits * 20 + overlap * 4 + memory.importance * 2 + 1 / (1 + ageDays / 30);
      return { memory, score, overlap, phraseHits };
    })
    .filter(({ memory, overlap, phraseHits }) => memory.pinned || phraseHits > 0 || overlap > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ memory }) => memory);
}

export async function relevantMemories(characterId: string, input: string, limit = 8) {
  const result = await query("SELECT * FROM memories WHERE character_id = $1 ORDER BY pinned DESC, created_at DESC LIMIT 300", [characterId]);
  return rankMemories(result.rows.map(memoryFromRow), input, limit);
}

type Consolidation = { summary?: string; memories?: Array<{ content?: string; importance?: number; keywords?: string[] }> };

export async function maybeConsolidate(conversationId: string, force = false) {
  const settings = await getSettings();
  const conversationResult = await query("SELECT * FROM conversations WHERE id = $1", [conversationId]);
  const conversation = conversationResult.rows[0];
  if (!conversation || (!force && Number(conversation.message_count) - Number(conversation.last_consolidated_count) < settings.consolidationInterval)) return false;
  if (Number(conversation.message_count) < 2) return false;

  const messageResult = await query(
    "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 14",
    [conversationId],
  );
  const messages = messageResult.rows.reverse().map(messageFromRow) as Message[];
  const raw = await completion([
    { role: "system", content: "You are a precise memory curator. Output JSON only." },
    { role: "user", content: consolidationPrompt(String(conversation.summary), messages, settings.ownerName) },
  ], { json: true, maxTokens: 1600, temperature: 0.2, model: settings.model });
  const data = parseJson<Consolidation>(raw);
  if (!data.summary) return false;

  await query("UPDATE conversations SET summary = $1, last_consolidated_count = message_count, updated_at = now() WHERE id = $2", [data.summary.slice(0, 12000), conversationId]);
  for (const item of (data.memories ?? []).slice(0, 6)) {
    if (!item.content?.trim()) continue;
    const duplicate = await query(
      "SELECT 1 FROM memories WHERE character_id = $1 AND lower(content) = lower($2) LIMIT 1",
      [conversation.character_id, item.content.trim()],
    );
    if (duplicate.rowCount) continue;
    await query(
      "INSERT INTO memories (id, character_id, conversation_id, content, importance, keywords) VALUES ($1,$2,$3,$4,$5,$6)",
      [randomUUID(), conversation.character_id, conversationId, item.content.trim().slice(0, 3000), Math.min(5, Math.max(1, Number(item.importance) || 3)), (item.keywords ?? []).slice(0, 12)],
    );
  }
  return true;
}
