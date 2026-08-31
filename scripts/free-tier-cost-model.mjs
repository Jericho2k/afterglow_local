#!/usr/bin/env node
/**
 * WHAT A FREE TIER WOULD ACTUALLY COST AFTERGLOW TO FUND.
 *
 * Section N of the model-expansion brief: before committing to an
 * Afterglow-funded fallback, work out what it costs at 100, 1,000 and 10,000
 * monthly active readers, under several cache-hit assumptions, at list prices
 * and at current prices separately.
 *
 * THE INPUT IS A MEASURED PROMPT SHAPE, NOT A GUESS. Afterglow's own
 * cacheability suite (tests/prompt-cacheability.test.ts) establishes two things
 * offline against the real prompt builder: a writer request is over 8,000
 * prompt tokens once a World is attached, and consecutive turns share about
 * 76.8% of their bytes — 81.2% on turns where the transcript anchor holds and
 * 45.6% on the roughly one-in-eight turns where it moves. The defaults below
 * come from that. Override them from production telemetry when you have it:
 * `--prompt-tokens`, `--output-tokens`, `--generations-per-reader`.
 *
 * WHAT THIS IS NOT. It is not a measurement of whether the cache HITS. A stable
 * prefix is necessary and not sufficient; only a provider's own `cached_tokens`
 * says whether the discount arrived, which is why the table runs the whole range
 * from 0% to 90% rather than picking one number and calling it the answer.
 *
 * PROMOTIONAL PRICES ARE REPORTED SEPARATELY AND NEVER MIXED IN. GLM 5.3 Flash
 * launched with a discount of roughly half, expiring in early September 2026.
 * Building a funded tier on a rate that expires in days would mean the model
 * breaking on the day it ends, so the headline table is LIST prices and the
 * discount is a second table clearly labelled as temporary.
 *
 * USAGE
 *   node scripts/free-tier-cost-model.mjs
 *   … --prompt-tokens 10000 --output-tokens 450
 *   … --generations-per-reader 100
 *   … --json
 *
 * No credentials, no network, no database. It is arithmetic over a rate card,
 * and the rate card is stated so it can be argued with.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : Number(args[at + 1]);
};
const asJson = args.includes("--json");

const promptTokens = option("prompt-tokens", 10_000);
const outputTokens = option("output-tokens", 450);
const generationsPerReader = option("generations-per-reader", 100);

/**
 * Rates per million tokens: fresh input / cached input / output.
 *
 * EVERY FIGURE HERE WAS READ FROM A SEARCH INDEX ON 2026-08-31 AND NOT FROM
 * OPENROUTER'S API, which this environment cannot reach. They are the basis of
 * a projection, not of a bill. `scripts/provider-pool-audit.mjs` is what checks
 * them against the live catalogue.
 *
 * Where a cached-input rate could not be established, it is set EQUAL to the
 * fresh rate rather than guessed downward: assuming a discount nobody has
 * confirmed would make the cheapest candidate look cheaper still, which is
 * exactly the direction a cost model must not be wrong in.
 */
const rates = {
  "GLM 4.7 — Z.AI (dearest in pool)": { fresh: 0.60, cached: 0.11, output: 2.20, basis: "list" },
  "GLM 4.7 — DeepInfra (cheapest in pool)": { fresh: 0.40, cached: 0.08, output: 1.75, basis: "list" },
  "GLM 5.3 Flash — list": { fresh: 0.15, cached: 0.03, output: 0.50, basis: "list" },
  "GLM 5.3 Flash — launch discount (EXPIRES ~2026-09-09)": { fresh: 0.075, cached: 0.015, output: 0.25, basis: "promotional" },
  "Ling 3.0 Flash": { fresh: 0.021, cached: 0.021, output: 0.063, basis: "list", note: "no cache-read rate confirmed; cached assumed EQUAL to fresh" },
  "Qwen3.8 Flash": { fresh: 0.15, cached: 0.016, output: 0.47, basis: "list" },
  "DeepSeek V4 Flash 0731 (background candidate)": { fresh: 0.03, cached: 0.03, output: 0.16, basis: "list", note: "cheapest endpoint; cached rate unconfirmed" },
  "DeepSeek V4 Flash direct — peak (memory incumbent)": { fresh: 0.44, cached: 0.014, output: 1.32, basis: "list", note: "time-of-day priced; off-peak is exactly half" },
};

const cacheAssumptions = [0, 0.5, 0.75, 0.85, 0.9];
const readerScales = [100, 1_000, 10_000];

function costPerGeneration(rate, cacheHitRatio) {
  const cached = promptTokens * cacheHitRatio;
  const fresh = promptTokens - cached;
  return (fresh * rate.fresh + cached * rate.cached + outputTokens * rate.output) / 1_000_000;
}

const table = Object.entries(rates).map(([label, rate]) => ({
  label, basis: rate.basis, note: rate.note ?? null,
  rate: { freshUsdPerMillion: rate.fresh, cachedUsdPerMillion: rate.cached, outputUsdPerMillion: rate.output },
  byCacheHit: cacheAssumptions.map((ratio) => {
    const perGeneration = costPerGeneration(rate, ratio);
    return {
      cacheHitRatio: ratio,
      perGenerationUsd: perGeneration,
      per100Usd: perGeneration * 100,
      per300Usd: perGeneration * 300,
      per1000Usd: perGeneration * 1000,
      monthlyUsd: Object.fromEntries(readerScales.map((readers) => [readers, perGeneration * generationsPerReader * readers])),
    };
  }),
}));

if (asJson) {
  console.log(JSON.stringify({ promptTokens, outputTokens, generationsPerReader, table }, null, 2));
  process.exit(0);
}

const usd = (value) => (value >= 100 ? `$${value.toFixed(0)}` : value >= 1 ? `$${value.toFixed(2)}` : `$${value.toFixed(5)}`);

console.log(`\nAfterglow funded-generation cost model`);
console.log(`Prompt ${promptTokens} tokens, output ${outputTokens} tokens, ${generationsPerReader} generations per reader per month.`);
console.log(`Prompt shape from tests/prompt-cacheability.test.ts (>8k tokens, ~76.8% shared bytes turn to turn).`);
console.log(`Rates read from a search index on 2026-08-31, NOT from OpenRouter's API. Verify with scripts/provider-pool-audit.mjs.\n`);

for (const row of table) {
  console.log(`${row.label}${row.basis === "promotional" ? "   ← TEMPORARY, do not build on this" : ""}`);
  console.log(`  $${row.rate.freshUsdPerMillion}/M fresh, $${row.rate.cachedUsdPerMillion}/M cached, $${row.rate.outputUsdPerMillion}/M out${row.note ? `  (${row.note})` : ""}`);
  console.log(`  cache   per gen      /100      /300     /1000     100 MAU    1k MAU   10k MAU`);
  for (const point of row.byCacheHit) {
    console.log(`  ${String(Math.round(point.cacheHitRatio * 100)).padStart(3)}%  ${usd(point.perGenerationUsd).padStart(9)} ${usd(point.per100Usd).padStart(9)} ${usd(point.per300Usd).padStart(9)} ${usd(point.per1000Usd).padStart(9)} ${usd(point.monthlyUsd[100]).padStart(11)} ${usd(point.monthlyUsd[1000]).padStart(9)} ${usd(point.monthlyUsd[10000]).padStart(9)}`);
  }
  console.log("");
}

console.log("Read this as a RANGE, not a forecast. Nothing here measures whether the cache actually");
console.log("hits — a stable prefix is necessary and not sufficient, and only a provider's own");
console.log("cached_tokens settles it. The 0% row is what a funded tier costs if it never hits.\n");
