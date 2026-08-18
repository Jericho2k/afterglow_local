import { randomUUID } from "node:crypto";
import { query } from "./db";
import type { DeepSeekUsage } from "./deepseek";

export type UsageKind = "chat" | "regenerate" | "continue" | "memory_consolidation" | "character_generation";

// Official USD prices per one million tokens, checked against DeepSeek's
// Models & Pricing page on 2026-08-18. Historical events store their estimate
// at write time so a later price change does not rewrite prior usage.
export const pricingAsOf = "2026-08-18";
export const modelPricing: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
  "deepseek-v4-flash": { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  "deepseek-v4-pro": { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
};

export function normalizedUsage(usage: DeepSeekUsage) {
  const promptTokens = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completionTokens = Math.max(0, Number(usage.completion_tokens) || 0);
  const cacheHitTokens = Math.max(0, Number(usage.prompt_cache_hit_tokens) || 0);
  const reportedMiss = Number(usage.prompt_cache_miss_tokens);
  const cacheMissTokens = Number.isFinite(reportedMiss) && reportedMiss >= 0
    ? reportedMiss
    : Math.max(0, promptTokens - cacheHitTokens);
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens };
}

export function estimateUsageCostUsd(model: string, usage: DeepSeekUsage) {
  const pricing = modelPricing[model];
  if (!pricing) return null;
  const normalized = normalizedUsage(usage);
  return (
    normalized.cacheHitTokens * pricing.cacheHit
    + normalized.cacheMissTokens * pricing.cacheMiss
    + normalized.completionTokens * pricing.output
  ) / 1_000_000;
}

export async function recordUsageEvent(input: { conversationId?: string | null; model: string; kind: UsageKind; usage: DeepSeekUsage }) {
  const usage = normalizedUsage(input.usage);
  const cost = estimateUsageCostUsd(input.model, input.usage);
  await query(
    `INSERT INTO usage_events
      (id,conversation_id,model,usage_type,prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,estimated_cost_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(),input.conversationId ?? null,input.model,input.kind,usage.promptTokens,usage.completionTokens,usage.cacheHitTokens,usage.cacheMissTokens,cost],
  );
}
