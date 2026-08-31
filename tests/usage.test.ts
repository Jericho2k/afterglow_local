import { describe, expect, it } from "vitest";
import { estimateUsageCostUsd, normalizedUsage } from "@/lib/usage";

describe("usage accounting", () => {
  it("prices every provider token category with the selected model", () => {
    const usage = {
      prompt_tokens: 2_000_000,
      completion_tokens: 1_000_000,
      prompt_cache_hit_tokens: 1_000_000,
      prompt_cache_miss_tokens: 1_000_000,
    };
    /*
     * The peak end of DeepSeek's time-of-day tariff, which is what a single
     * figure means for a model whose price depends on when the request landed.
     * See tests/deepseek-tariff.test.ts for the range and the reasoning.
     */
    // Flash peak: 1M cached at 0.014 + 1M fresh at 0.44 + 1M out at 1.32.
    expect(estimateUsageCostUsd("deepseek-v4-flash",usage)).toBeCloseTo(1.774,10);
    // Pro peak: 1M cached at 0.044 + 1M fresh at 1.32 + 1M out at 3.96.
    expect(estimateUsageCostUsd("deepseek-v4-pro",usage)).toBeCloseTo(5.324,10);
  });

  it("derives cache misses when the provider omits that optional counter", () => {
    expect(normalizedUsage({ prompt_tokens: 900, completion_tokens: 100, prompt_cache_hit_tokens: 350 })).toMatchObject({
      promptTokens: 900,
      completionTokens: 100,
      cacheHitTokens: 350,
      cacheMissTokens: 550,
    });
  });

  it("normalizes OpenRouter cache, reasoning, latency, and native cost metadata", () => {
    expect(normalizedUsage({
      prompt_tokens: 1000,
      completion_tokens: 250,
      prompt_tokens_details: { cached_tokens: 400,cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 75 },
      cost: 0.0042,
      cost_details: { upstream_inference_cost: 0.0038 },
      latency_ms: 987.4,
      ttft_ms: 321.4,
    })).toEqual({
      promptTokens:1000,completionTokens:250,cacheHitTokens:400,cacheMissTokens:600,
      cacheWriteTokens:50,reasoningTokens:75,providerCostUsd:0.0042,upstreamCostUsd:0.0038,latencyMs:987,ttftMs:321,
    });
  });

  it("leaves unknown custom models unpriced instead of inventing a rate", () => {
    expect(estimateUsageCostUsd("custom-model",{ prompt_tokens: 100 })).toBeNull();
  });
});
