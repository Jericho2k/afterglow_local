import { randomUUID } from "node:crypto";
import { userQuery } from "./db";
import type { LLMUsage } from "./llm";
import type { ResponseLength } from "./types";

export type UsageKind = "chat" | "regenerate" | "continue" | "memory_consolidation" | "memory_curation" | "scene_state" | "character_generation" | "embedding";

/**
 * WHAT A TOKEN COSTS, AND HOW SURE WE ARE.
 *
 * Historical events store their estimate at write time, so a later price change
 * never rewrites prior usage. That has always been the rule here and it is now
 * stated in the data as well as in this comment: every new event records which
 * price table produced its number and how that number was arrived at.
 *
 * DEEPSEEK IS NOW TIME-OF-DAY PRICED, and the old table was stale by a factor
 * of about 1.6 to 4.7 besides. A request costs one rate inside a peak window and
 * half that outside it, which means a single number for "what did this cost" is
 * no longer available from tokens alone.
 *
 * THE SCHEDULE IS DELIBERATELY NOT ENCODED. DeepSeek's own pricing
 * documentation is the only authority for where the peak windows fall, and it
 * is not reachable from this environment — the egress policy denies
 * api-docs.deepseek.com and deepseek.com outright. Secondary write-ups agree
 * with each other about the hours, and agreeing with each other is not the same
 * as being right; hardcoding a tariff boundary from them would produce numbers
 * that look authoritative and silently misprice every request near a window
 * edge. So the estimate is a RANGE, and the single figure operators spend
 * against is the PEAK end of it. Over-stating spend is a recoverable error;
 * under-stating it is the one that surprises somebody.
 *
 * When the documentation becomes reachable, encoding the schedule is a small
 * change: `deepseekTariff` below is the only thing that has to learn about time.
 */
export const pricingAsOf = "2026-08-31";
/**
 * Bumped whenever a rate in this file changes. Stored on every new event so a
 * re-priced analysis can tell which table produced a given row, without
 * touching the row.
 */
export const pricingVersion = 2;

/** How a stored cost figure was arrived at. */
export type CostBasis =
  /** The provider reported the real charge for this generation. Authoritative. */
  | "provider_reported"
  /** Our own table, one flat rate. An estimate. */
  | "estimated"
  /** Our own table, time-of-day priced, taken at the PEAK rate. An estimate. */
  | "estimated_peak"
  /** No rate is known for this model. */
  | "unpriced";

/** USD per million tokens, at each end of a time-of-day tariff. */
export type TariffRates = { cacheHit: number; cacheMiss: number; output: number };

/**
 * DeepSeek's two tariffs, per million tokens.
 *
 * Off-peak is exactly half of peak on every line, which is the one property of
 * the scheme every source agrees on and the only one this file relies on.
 */
export const deepseekTariff: Record<string, { offPeak: TariffRates; peak: TariffRates }> = {
  "deepseek-v4-flash": {
    offPeak: { cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 },
    peak: { cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 },
  },
  "deepseek-v4-pro": {
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
};

export const modelPricing: Record<string, TariffRates> = {
  // The peak end of the tariff above: what an operator budgets against.
  "deepseek-v4-flash": deepseekTariff["deepseek-v4-flash"].peak,
  "deepseek-v4-pro": deepseekTariff["deepseek-v4-pro"].peak,
  /*
   * OpenRouter models, checked against their catalogue pages on 2026-08-25.
   *
   * These are a FALLBACK, not the source of truth. OpenRouter reports the real
   * charge for each generation in `usage.cost`, and `recordUsageEvent` prefers
   * it; this table only fills the gap when a response arrives without one, so
   * that a MiMo turn is never silently recorded as costing nothing.
   *
   * The cached-input rate is what makes MiMo interesting: about one forty-sixth
   * of the fresh-input rate. Whether that discount actually arrives in
   * Afterglow's traffic is a measurement, not a property of this table.
   */
  "mimo-v2.5": { cacheHit: 0.00255, cacheMiss: 0.119, output: 0.238 },
  "mimo-v2.5-pro": { cacheHit: 0.0028, cacheMiss: 0.3045, output: 0.609 },
  "midnight-cherry": { cacheHit: 0.55, cacheMiss: 0.55, output: 0.80 },
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

function applyRates(usage: LLMUsage, rates: TariffRates) {
  const normalized = normalizedUsage(usage);
  return (
    normalized.cacheHitTokens * rates.cacheHit
    + normalized.cacheMissTokens * rates.cacheMiss
    + normalized.completionTokens * rates.output
  ) / 1_000_000;
}

/**
 * What this generation cost, as far as our own table can say.
 *
 * A single number for a time-of-day priced model is a guess about when the
 * request landed. This is the peak figure — see the note at the top of the file
 * for why the conservative end — and `estimateUsageCostRange` is what to show
 * anybody who needs to see the uncertainty rather than absorb it.
 */
export function estimateUsageCostUsd(model: string, usage: LLMUsage) {
  const pricing = modelPricing[model];
  return pricing ? applyRates(usage, pricing) : null;
}

/**
 * The band this generation cost, for a model whose price depends on the clock.
 *
 * `low` and `high` are equal for a flat-rate model, which is what lets a caller
 * render "about $X" and "$X–$Y" from the same shape.
 */
export function estimateUsageCostRange(model: string, usage: LLMUsage) {
  const tariff = deepseekTariff[model];
  if (tariff) {
    return {
      low: applyRates(usage, tariff.offPeak),
      high: applyRates(usage, tariff.peak),
      basis: "estimated_peak" as const,
    };
  }
  const flat = modelPricing[model];
  if (!flat) return null;
  const value = applyRates(usage, flat);
  return { low: value, high: value, basis: "estimated" as const };
}

/** Whether this model's price depends on when the request landed. */
export function isTimeOfDayPriced(model: string) {
  return model in deepseekTariff;
}

/**
 * Appends one billable event to the ledger, attributed to the account that
 * caused it. Every paid call routes through here, so per-account cost, token
 * and volume reporting is a single grouped query away.
 */
export async function recordUsageEvent(input: { userId: string; conversationId?: string | null; providerId?: string; model: string; actualModel?: string; rpEngineId?: string; responseLength?: ResponseLength; fundingSource?: "afterglow" | "byok" | "self_hosted"; kind: UsageKind; taskRoute?: string; usage: LLMUsage }) {
  const usage = normalizedUsage(input.usage);
  /*
   * PROVIDER-REPORTED COST WINS, ALWAYS.
   *
   * OpenRouter returns the real charge for the generation in `usage.cost`. That
   * is not an estimate and is never second-guessed by our table. Everything
   * else is our arithmetic, and the row now records which of the two it is so a
   * spend view can say "estimated" where it means estimated.
   */
  const estimate = estimateUsageCostRange(input.model,input.usage);
  const cost = usage.providerCostUsd ?? estimate?.high ?? null;
  const basis: CostBasis = usage.providerCostUsd !== null ? "provider_reported" : estimate?.basis ?? "unpriced";
  const providerMetadata = {
    /*
     * Pricing metadata travels WITH the event and is never revised.
     *
     * A re-priced analysis is a legitimate thing to want and it is not this
     * table's job: the ledger records what was believed at the time, and any
     * view that wants today's rates can recompute from the token counts, which
     * are facts rather than beliefs.
     */
    pricing: {
      version: pricingVersion,
      asOf: pricingAsOf,
      basis,
      ...(estimate && estimate.low !== estimate.high
        ? { estimatedOffPeakUsd: estimate.low, estimatedPeakUsd: estimate.high }
        : {}),
    },
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
