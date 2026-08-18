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
    expect(estimateUsageCostUsd("deepseek-v4-flash",usage)).toBeCloseTo(0.4228,10);
    expect(estimateUsageCostUsd("deepseek-v4-pro",usage)).toBeCloseTo(1.308625,10);
  });

  it("derives cache misses when the provider omits that optional counter", () => {
    expect(normalizedUsage({ prompt_tokens: 900, completion_tokens: 100, prompt_cache_hit_tokens: 350 })).toEqual({
      promptTokens: 900,
      completionTokens: 100,
      cacheHitTokens: 350,
      cacheMissTokens: 550,
    });
  });

  it("leaves unknown custom models unpriced instead of inventing a rate", () => {
    expect(estimateUsageCostUsd("custom-model",{ prompt_tokens: 100 })).toBeNull();
  });
});
