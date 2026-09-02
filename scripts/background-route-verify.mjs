#!/usr/bin/env node
/**
 * ARE THE PINNED UPSTREAM TAGS STILL SERVED?
 *
 * Two of the memory candidates exist to pin one upstream host each —
 * `open-inference/fp8` and `relace/fp4` serving DeepSeek V4 Flash 0731 — and
 * pinning a host means `provider.only` with fallbacks off. That makes the tag
 * load bearing in a way an ordinary route's is not: a wrong `order` entry is
 * ignored and the request goes somewhere sensible, while a wrong `only` entry
 * is a request with an empty candidate set. For a background job that means
 * every consolidation fails, quietly, because background jobs never reach a
 * reader to complain.
 *
 * Those two tags are verified. This script is how they STAY verified: a third
 * party can rename or retire a tag without telling us, so it asks OpenRouter
 * which endpoints actually serve the model, checks the exact strings the
 * catalogue pins, and prints the prices and the environment line.
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
 * THE TAGS THE CATALOGUE NOW PINS, EXACTLY AS `provider.only` MATCHES THEM.
 *
 * These were guesses once — "openinference" and "relace", the obvious lowercase
 * forms of two host names — and the guesses were wrong in two different ways:
 * a hyphen nobody would have added, and a quantisation suffix nobody would have
 * known to look for. So the script no longer hunts for a plausible-looking host
 * and reports what it found. It asks whether THESE EXACT STRINGS are still
 * served, which is the only question `provider.only` cares about.
 *
 * `label` is only for reading the output. `tag` is the load-bearing value and
 * must stay identical to `dedicatedProvider` in src/lib/provider.ts.
 */
const wanted = [
  { label: "OpenInference", tag: "open-inference/fp8" },
  { label: "Relace", tag: "relace/fp4" },
];

/**
 * A host that is plausibly the same one under a changed tag.
 *
 * Reported, never accepted. If OpenRouter renames `relace/fp4` to `relace/fp8`
 * this finds it and says so — and still refuses to print it into the
 * environment line, because the catalogue entry has to be corrected first or
 * the pin will point at a tag the code does not carry.
 */
function looksRelated(slug, tag) {
  const root = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return root(String(slug).split("/")[0]) === root(tag.split("/")[0]);
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

console.log("\nThe exact tags the memory candidates pin:\n");
const confirmed = [];
for (const target of wanted) {
  const exact = rows.find((row) => String(row.slug) === target.tag);
  if (exact) {
    console.log(`  ${target.tag}  (${target.label})  STILL SERVED`);
    console.log(`      prices: $${exact.promptUsdPerMillion?.toFixed(4) ?? "—"}/M fresh, ${exact.cachedReadUsdPerMillion === null ? "NO discounted cache reads" : `$${exact.cachedReadUsdPerMillion.toFixed(4)}/M cached`}, $${exact.completionUsdPerMillion?.toFixed(4) ?? "—"}/M output`);
    if (exact.quantization) console.log(`      quantisation: ${exact.quantization}`);
    confirmed.push(target.tag);
    continue;
  }
  console.log(`  ${target.tag}  (${target.label})  NOT SERVED under this exact tag.`);
  const related = rows.filter((row) => looksRelated(row.slug, target.tag)).map((row) => row.slug);
  if (related.length) {
    console.log(`      The same host appears as: ${related.join(", ")}`);
    console.log("      DO NOT paste that into the environment. `provider.only` matches the tag");
    console.log("      the catalogue carries, so src/lib/provider.ts must be corrected first.");
  } else {
    console.log("      That host is not in the list above at all. Leave the candidate disabled.");
  }
}

console.log("");
if (confirmed.length === wanted.length) {
  console.log("Both tags confirmed. If you are willing to send background memory work to these hosts, set:\n");
} else if (confirmed.length) {
  console.log("Some tags confirmed. Opt into only the ones you are willing to use:\n");
}
if (confirmed.length) {
  console.log(`  BACKGROUND_ROUTE_VERIFIED_UPSTREAMS=${confirmed.join(",")}\n`);
  console.log("The tag being served is not consent to use it. Until that variable names a host,");
  console.log("the admin selector lists its candidate, explains the gate, and refuses to select it.");
} else {
  console.log("Nothing confirmed. Leave BACKGROUND_ROUTE_VERIFIED_UPSTREAMS unset — the candidates stay listed and unselectable.");
}
console.log("");
