import { randomUUID } from "node:crypto";
import { userQuery } from "./db";
import type { LLMUsage } from "./llm";
import type { ResponseLength } from "./types";

export type UsageKind = "chat" | "regenerate" | "continue" | "memory_consolidation" | "memory_curation" | "scene_state" | "character_generation" | "embedding";

/**
 * Who paid for one generation.
 *
 * Five values rather than three, because the free tier introduced two funding
 * sources that are neither ordinary platform spend nor the reader's own key,
 * and collapsing either into `afterglow` would make the free tier's real cost
 * unreadable in exactly the report an operator opens to find it.
 *
 *   afterglow        Ordinary paid inference for a paid model.
 *   byok             The reader's own OpenRouter account. Costs Afterglow
 *                    nothing, `:free` routes included.
 *   shared_free      The platform account's free-model quota. Costs no money
 *                    and does consume a scarce, shared, daily allowance.
 *   platform_funded  Afterglow paying for an ultra-cheap writer because free
 *                    capacity was gone. THE LINE TO WATCH: this is the only
 *                    one where a free-tier reader generates real spend.
 *   self_hosted      A deployment running its own inference.
 */
export type FundingSource = "afterglow" | "byok" | "self_hosted" | "shared_free" | "platform_funded";

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
export const pricingVersion = 4;

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
  /*
   * GLM 4.7, at the DEAREST endpoint its cost ceiling admits.
   *
   * It had no entry at all, so a GLM generation whose response arrived without
   * `usage.cost` — a stream that ended early, an endpoint that omitted it — was
   * recorded as `unpriced` and counted as costing nothing. A writer silently
   * missing from a spend report is the worst kind of wrong number, because
   * nothing about the report looks broken.
   *
   * Z.AI's rates rather than DeepInfra's on purpose. Several endpoints serve
   * this slug at different prices and a fallback cannot know which one ran;
   * quoting the cheapest would understate spend exactly when the cheapest
   * endpoint is the one that failed to report. The ceiling in
   * `src/lib/provider.ts` guarantees no eligible endpoint is dearer than this,
   * so the estimate is an upper bound by construction.
   *
   * It remains a FALLBACK. OpenRouter reports the real charge on a healthy
   * response and `recordUsageEvent` always prefers it.
   */
  "glm-4.7": { cacheHit: 0.11, cacheMiss: 0.60, output: 2.20 },
  /*
   * The 2026-08 lineup, priced at the DEAREST endpoint each model's ceiling
   * admits, for the same reason GLM 4.7 is: a fallback cannot know which
   * endpoint ran, and quoting the cheapest would understate spend precisely
   * when the cheapest endpoint is the one that failed to report a cost.
   *
   * THESE ARE LIST PRICES, NOT PROMOTIONAL ONES. GLM 5.3 Flash was launched
   * with a temporary discount of roughly half, expiring in early September
   * 2026. Recording the discounted rate here would make every spend report
   * quietly wrong the day it ends, and would make the free-tier projections
   * built on it wrong from the start. The discount is reported separately in
   * docs/model-lineup-2026-08.md and is deliberately absent from the arithmetic
   * anything is budgeted against.
   *
   * All three were read from a search index on 2026-08-31, not from
   * OpenRouter's API, which this environment cannot reach. They are fallbacks:
   * OpenRouter reports the real charge on a healthy response and
   * `recordUsageEvent` always prefers it.
   */
  "glm-5.3-flash": { cacheHit: 0.03, cacheMiss: 0.15, output: 0.50 },
  "glm-5.3-flash-economy": { cacheHit: 0.03, cacheMiss: 0.15, output: 0.50 },
  "ling-3.0-flash": { cacheHit: 0.0042, cacheMiss: 0.021, output: 0.063 },
  "qwen3.8-flash": { cacheHit: 0.016, cacheMiss: 0.15, output: 0.47 },
  /*
   * The curated free routes cost nothing, and saying so in the table is what
   * stops them being recorded as `unpriced`.
   *
   * "Unpriced" and "free" look identical in a spend total and mean opposite
   * things: the first is a gap in the ledger and the second is a fact. A free
   * generation is not free of CONSEQUENCE — it consumes a scarce shared daily
   * allowance — and that scarcity is accounted for in free_tier_pool_days,
   * which is a count of generations rather than a sum of dollars.
   */
  "ling-3.0-flash-free": { cacheHit: 0, cacheMiss: 0, output: 0 },
  "minimax-m2.5-free": { cacheHit: 0, cacheMiss: 0, output: 0 },
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
export async function recordUsageEvent(input: { userId: string; conversationId?: string | null; providerId?: string; model: string; actualModel?: string; rpEngineId?: string; responseLength?: ResponseLength; fundingSource?: FundingSource; kind: UsageKind; taskRoute?: string; usage: LLMUsage }) {
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
