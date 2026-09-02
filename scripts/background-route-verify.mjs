#!/usr/bin/env node
/**
 * WHAT ARE THE UPSTREAM HOSTS ACTUALLY CALLED?
 *
 * Two of the memory candidates exist to pin one upstream host each —
 * "OpenInference" and "Relace" serving DeepSeek V4 Flash 0731 — and pinning a
 * host means `provider.only` with fallbacks off. That makes the slug load
 * bearing in a way an ordinary route's is not: a wrong `order` entry is
 * ignored and the request goes somewhere sensible, while a wrong `only` entry
 * is a request with an empty candidate set. For a background job that means
 * every consolidation fails, quietly, because background jobs never reach a
 * reader to complain.
 *
 * The catalogue therefore carries the plausible lowercase forms and refuses to
 * let anybody select them until an operator has confirmed the real ones. This
 * script is the confirmation: it asks OpenRouter which endpoints actually serve
 * a model and prints the slugs, the prices, and the line to put in the
 * environment.
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/background-route-verify.mjs
 *   … --model deepseek/deepseek-v4-flash-0731     (default)
 *   … --json
 *
 * It makes NO inference calls and spends nothing: the endpoint catalogue is a
 * GET. Nothing is written anywhere — the environment line is printed for a
 * human to paste, because "the API said the host exists" and "we are willing to
 * send readers' transcripts to it" are different decisions and only the first
 * one is a script's to make.
 */

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? true);
}
const asJson = args.includes("--json");
const model = String(flag("model", "deepseek/deepseek-v4-flash-0731"));

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("OPENROUTER_API_KEY is required. This script reads OpenRouter's endpoint catalogue and cannot guess it.");
  process.exit(2);
}

const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

/**
 * The hosts the brief named, lowercased.
 *
 * Matched loosely against what the catalogue returns, because a provider's
 * display name and its routing slug are not the same string and the whole
 * point of this script is that we do not know which is which.
 */
const wanted = ["openinference", "relace"];

function normalise(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const response = await fetch(`${base}/models/${model}/endpoints`, {
  headers: { Authorization: `Bearer ${key}` },
});
if (!response.ok) {
  console.error(`OpenRouter answered ${response.status} for ${model}: ${(await response.text()).slice(0, 400)}`);
  process.exit(1);
}
const body = await response.json();
const endpoints = Array.isArray(body?.data?.endpoints) ? body.data.endpoints : [];

const rows = endpoints.map((endpoint) => ({
  name: endpoint?.name ?? "",
  // `tag` is the value `provider.only` matches on. `provider_name` is the
  // display name a human recognises. They are frequently different, and using
  // the second where the first is required is the exact failure this guards.
  slug: endpoint?.tag ?? endpoint?.provider_name ?? "",
  contextTokens: endpoint?.context_length ?? null,
  promptUsdPerMillion: endpoint?.pricing?.prompt ? Number(endpoint.pricing.prompt) * 1e6 : null,
  completionUsdPerMillion: endpoint?.pricing?.completion ? Number(endpoint.pricing.completion) * 1e6 : null,
  cachedReadUsdPerMillion: endpoint?.pricing?.input_cache_read ? Number(endpoint.pricing.input_cache_read) * 1e6 : null,
  supportsCaching: Boolean(endpoint?.pricing?.input_cache_read),
  quantization: endpoint?.quantization ?? null,
  status: endpoint?.status ?? null,
}));

if (asJson) {
  console.log(JSON.stringify({ model, endpoints: rows }, null, 2));
  process.exit(0);
}

console.log(`\n${model} — ${rows.length} upstream endpoint(s)\n`);
const width = Math.max(20, ...rows.map((row) => String(row.slug).length));
console.log(`${"slug".padEnd(width)}  ${"prompt $/M".padStart(11)}  ${"cached $/M".padStart(11)}  ${"out $/M".padStart(9)}  quant`);
for (const row of rows) {
  console.log([
    String(row.slug).padEnd(width),
    (row.promptUsdPerMillion === null ? "—" : row.promptUsdPerMillion.toFixed(4)).padStart(11),
    (row.cachedReadUsdPerMillion === null ? "none" : row.cachedReadUsdPerMillion.toFixed(4)).padStart(11),
    (row.completionUsdPerMillion === null ? "—" : row.completionUsdPerMillion.toFixed(4)).padStart(9),
    row.quantization ?? "—",
  ].join("  "));
}

console.log("\nThe two hosts the memory candidates pin:\n");
const confirmed = [];
for (const target of wanted) {
  const match = rows.find((row) => normalise(row.slug) === target || normalise(row.name).includes(target));
  if (!match) {
    console.log(`  ${target}: NOT FOUND on this model. Do not enable the candidate; either the host does not serve`);
    console.log("             this slug, or it is called something else in the list above.");
    continue;
  }
  const exact = normalise(match.slug) === target;
  console.log(`  ${target}: found as "${match.slug}"${exact ? "" : "  ← DIFFERENT SLUG: the catalogue entry in src/lib/provider.ts must be corrected first"}`);
  console.log(`             caching: ${match.supportsCaching ? `yes, cached reads at $${match.cachedReadUsdPerMillion?.toFixed(4)}/M` : "NO discounted cache reads"}`);
  if (exact) confirmed.push(match.slug);
}

console.log("");
if (confirmed.length) {
  console.log("If you are willing to send background memory work to these hosts, set:\n");
  console.log(`  BACKGROUND_ROUTE_VERIFIED_UPSTREAMS=${confirmed.join(",")}\n`);
  console.log("Until that variable names a host, the admin selector lists its candidate and refuses it.");
} else {
  console.log("Nothing confirmed. Leave BACKGROUND_ROUTE_VERIFIED_UPSTREAMS unset — the candidates stay listed and unselectable.");
}
console.log("");
