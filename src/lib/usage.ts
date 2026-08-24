import { randomUUID } from "node:crypto";
import { userQuery } from "./db";
import type { LLMUsage } from "./llm";
import type { ResponseLength } from "./types";

export type UsageKind = "chat" | "regenerate" | "continue" | "memory_consolidation" | "memory_curation" | "scene_state" | "character_generation" | "embedding";

// Official USD prices per one million tokens, checked against DeepSeek's
// Models & Pricing page on 2026-08-18. Historical events store their estimate
// at write time so a later price change does not rewrite prior usage.
export const pricingAsOf = "2026-08-18";
export const modelPricing: Record<string, { cacheHit: number; cacheMiss: number; output: number }> = {
  "deepseek-v4-flash": { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 },
  "deepseek-v4-pro": { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 },
};

export function normalizedUsage(usage: LLMUsage) {
  const promptTokens = Math.max(0, Number(usage.prompt_tokens) || 0);
  const completionTokens = Math.max(0, Number(usage.completion_tokens) || 0);
  const cacheHitTokens = Math.max(0, Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0);
  const reportedMiss = Number(usage.prompt_cache_miss_tokens);
  const cacheMissTokens = Number.isFinite(reportedMiss) && reportedMiss >= 0
    ? reportedMiss
    : Math.max(0, promptTokens - cacheHitTokens);
  const cacheWriteTokens = Math.max(0,Number(usage.prompt_tokens_details?.cache_write_tokens) || 0);
  const reasoningTokens = Math.max(0,Number(usage.completion_tokens_details?.reasoning_tokens) || 0);
  const providerCostUsd = Number.isFinite(Number(usage.cost)) && Number(usage.cost) >= 0 ? Number(usage.cost) : null;
  const upstreamCostUsd = Number.isFinite(Number(usage.cost_details?.upstream_inference_cost)) && Number(usage.cost_details?.upstream_inference_cost) >= 0
    ? Number(usage.cost_details?.upstream_inference_cost) : null;
  const latencyMs = Number.isFinite(Number(usage.latency_ms)) && Number(usage.latency_ms) >= 0 ? Math.round(Number(usage.latency_ms)) : null;
  const ttftMs = Number.isFinite(Number(usage.ttft_ms)) && Number(usage.ttft_ms) >= 0 ? Math.round(Number(usage.ttft_ms)) : null;
  return { promptTokens, completionTokens, cacheHitTokens, cacheMissTokens, cacheWriteTokens, reasoningTokens, providerCostUsd, upstreamCostUsd, latencyMs,ttftMs };
}

export function estimateUsageCostUsd(model: string, usage: LLMUsage) {
  const pricing = modelPricing[model];
  if (!pricing) return null;
  const normalized = normalizedUsage(usage);
  return (
    normalized.cacheHitTokens * pricing.cacheHit
    + normalized.cacheMissTokens * pricing.cacheMiss
    + normalized.completionTokens * pricing.output
  ) / 1_000_000;
}

/**
 * Appends one billable event to the ledger, attributed to the account that
 * caused it. Every paid call routes through here, so per-account cost, token
 * and volume reporting is a single grouped query away.
 */
export async function recordUsageEvent(input: { userId: string; conversationId?: string | null; providerId?: string; model: string; actualModel?: string; rpEngineId?: string; responseLength?: ResponseLength; fundingSource?: "afterglow" | "byok" | "self_hosted"; kind: UsageKind; taskRoute?: string; usage: LLMUsage }) {
  const usage = normalizedUsage(input.usage);
  const cost = usage.providerCostUsd ?? estimateUsageCostUsd(input.model,input.usage);
  const providerMetadata = {
    ...(input.usage.prompt_tokens_details ? { promptTokensDetails: input.usage.prompt_tokens_details } : {}),
    ...(input.usage.completion_tokens_details ? { completionTokensDetails: input.usage.completion_tokens_details } : {}),
    ...(input.usage.cost_details ? { costDetails: input.usage.cost_details } : {}),
    ...(input.usage.upstream_provider ? { upstreamProvider:input.usage.upstream_provider } : {}),
  };
  await userQuery(
    input.userId,
    `INSERT INTO usage_events
      (id,conversation_id,user_id,provider_id,model,actual_provider_model,catalog_model_id,rp_engine_id,response_length,funding_source,usage_type,task_route,
       prompt_tokens,completion_tokens,cache_hit_tokens,cache_miss_tokens,cache_write_tokens,reasoning_tokens,estimated_cost_usd,provider_cost_usd,
       upstream_cost_usd,latency_ms,ttft_ms,upstream_provider,provider_request_id,provider_metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26::jsonb)`,
    [randomUUID(),input.conversationId ?? null,input.userId,input.providerId ?? "deepseek",input.model,input.actualModel ?? input.usage.actual_model ?? input.model,input.model,input.rpEngineId ?? "immersive",input.responseLength ?? null,input.fundingSource ?? "afterglow",input.kind,input.taskRoute ?? input.kind,
      usage.promptTokens,usage.completionTokens,usage.cacheHitTokens,usage.cacheMissTokens,usage.cacheWriteTokens,usage.reasoningTokens,cost,usage.providerCostUsd,usage.upstreamCostUsd,usage.latencyMs,usage.ttftMs,input.usage.upstream_provider??null,input.usage.provider_request_id ?? null,JSON.stringify(providerMetadata)],
  );
}
