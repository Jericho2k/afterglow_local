import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deepseekTariff, estimateUsageCostRange, estimateUsageCostUsd, isTimeOfDayPriced,
  modelPricing, pricingAsOf, pricingVersion,
} from "@/lib/usage";

/**
 * DeepSeek is billed direct and is now priced by time of day: the same tokens
 * cost twice as much inside a peak window as outside it. The internal table was
 * also stale by a factor of roughly 1.6 to 4.7.
 *
 * THE SCHEDULE IS DELIBERATELY ABSENT. DeepSeek's own documentation is the only
 * authority for where the windows fall and it is not reachable from this
 * environment. Secondary write-ups agree with one another, which is not the
 * same as being right, and a hardcoded boundary taken from them would misprice
 * every request near a window edge while looking authoritative. So the estimate
 * is a range and the single figure is the conservative end of it.
 */

const oneMillionEach = {
  prompt_tokens: 1_000_000,
  completion_tokens: 1_000_000,
  prompt_cache_hit_tokens: 1_000_000,
  prompt_cache_miss_tokens: 1_000_000,
};

describe("the supplied DeepSeek rates", () => {
  it("records V4 Flash at both tariffs", () => {
    expect(deepseekTariff["deepseek-v4-flash"].offPeak).toEqual({ cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 });
    expect(deepseekTariff["deepseek-v4-flash"].peak).toEqual({ cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 });
  });

  it("records V4 Pro at both tariffs", () => {
    expect(deepseekTariff["deepseek-v4-pro"].offPeak).toEqual({ cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 });
    expect(deepseekTariff["deepseek-v4-pro"].peak).toEqual({ cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 });
  });

  it("keeps off-peak at exactly half of peak on every line", () => {
    for (const tariff of Object.values(deepseekTariff)) {
      for (const line of ["cacheHit", "cacheMiss", "output"] as const) {
        expect(tariff.offPeak[line] * 2).toBeCloseTo(tariff.peak[line], 10);
      }
    }
  });

  it("is no longer the stale table it replaced", () => {
    // The old figures: 0.0028 / 0.14 / 0.28 for Flash.
    expect(modelPricing["deepseek-v4-flash"].output).not.toBe(0.28);
    expect(modelPricing["deepseek-v4-flash"].cacheMiss).toBeGreaterThan(0.14);
  });
});

describe("a single figure for a time-of-day price is the conservative one", () => {
  it("budgets DeepSeek at peak", () => {
    expect(modelPricing["deepseek-v4-flash"]).toEqual(deepseekTariff["deepseek-v4-flash"].peak);
    const single = estimateUsageCostUsd("deepseek-v4-flash", oneMillionEach);
    const range = estimateUsageCostRange("deepseek-v4-flash", oneMillionEach)!;
    expect(single).toBeCloseTo(range.high, 12);
    expect(range.low).toBeCloseTo(range.high / 2, 12);
  });

  it("says the estimate is a peak estimate rather than a bill", () => {
    expect(estimateUsageCostRange("deepseek-v4-flash", oneMillionEach)!.basis).toBe("estimated_peak");
    expect(isTimeOfDayPriced("deepseek-v4-flash")).toBe(true);
  });

  it("collapses the range for a flat-rate model", () => {
    const range = estimateUsageCostRange("midnight-cherry", oneMillionEach)!;
    expect(range.low).toBe(range.high);
    expect(range.basis).toBe("estimated");
    expect(isTimeOfDayPriced("midnight-cherry")).toBe(false);
  });

  it("returns nothing rather than zero for a model with no rate", () => {
    expect(estimateUsageCostRange("a-model-we-have-no-price-for", oneMillionEach)).toBe(null);
    expect(estimateUsageCostUsd("a-model-we-have-no-price-for", oneMillionEach)).toBe(null);
  });

  it("does not encode a peak schedule anywhere", () => {
    // If this ever fails, the authoritative documentation became reachable and
    // somebody encoded the windows — which is fine, but the range and the
    // "estimated" labelling then need revisiting rather than deleting.
    const text = readFileSync(new URL("../src/lib/usage.ts", import.meta.url), "utf8");
    expect(text).not.toMatch(/getUTCHours|peakHours|offPeakWindow/);
  });
});

describe("the ledger records what it believed, and when", () => {
  it("carries a pricing version and date that move together with the rates", () => {
    expect(pricingVersion).toBeGreaterThanOrEqual(2);
    expect(pricingAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("never rewrites an existing estimate in the legacy backfill", () => {
    const db = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
    const backfill = db.slice(db.indexOf("UPDATE usage_events SET estimated_cost_usd"));
    expect(backfill.slice(0, 900)).toContain("WHERE estimated_cost_usd IS NULL");
  });
});
