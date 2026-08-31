#!/usr/bin/env node
/**
 * IS THE APPROVED PROVIDER POOL STILL TRUE?
 *
 * `src/lib/provider.ts` declares, for each guarded model, a pool of upstream
 * endpoints that are supposed to be BOTH inside the price envelope AND
 * cache-capable for prompt reads, and in `cost_guarded` mode that pool is sent
 * as `provider.only`. Three things can make it wrong without anybody noticing:
 *
 *   A SLUG IS RENAMED OR RETIRED. `only` then names endpoints that do not
 *   exist, and every request for that model fails. This is the reason the pool
 *   was advisory for a whole sprint, and the reason this script exists.
 *
 *   A POOL MEMBER STOPS DISCOUNTING CACHE READS. The ceiling still passes, the
 *   requests still succeed, and a long conversation quietly starts paying fresh
 *   prices for the character, world and rules it resends every turn — which is
 *   most of the bill. Nothing fails. The invoice changes.
 *
 *   A POOL MEMBER RE-PRICES ABOVE THE CEILING. `max_price` catches this at
 *   request time, but silently: the pool shrinks and nobody is told.
 *
 * It reads the catalogue and the per-model endpoint list and makes NO inference
 * calls, so it costs nothing to run and can be put on a schedule.
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/provider-pool-audit.mjs
 *   … --json                    machine-readable output
 *   … --model glm-4.7           audit one catalogue entry
 *
 * EXIT CODE is 1 when any pool member is missing, dearer than its ceiling, or
 * has no cache-read price — so this can gate a deploy.
 *
 * THE TARGETS BELOW MIRROR src/lib/provider.ts BY HAND. That is deliberate and
 * is the same choice scripts/glm-routing-benchmark.mjs makes: an auditor that
 * imported the thing it audits could only ever agree with it, and this script
 * has to be able to say "the catalogue is wrong".
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};
const asJson = args.includes("--json");

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required: this audit checks the LIVE catalogue on purpose.");
  console.error("");
  console.error("Without it, every claim about which endpoints serve a model, what they charge,");
  console.error("and whether they discount cache reads is a claim about a web page somebody read");
  console.error("once. Skipping loudly is the honest outcome; do not infer a pool from this file.");
  process.exit(2);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

/** One catalogue entry, as this audit understands it. */
const targets = [
  {
    id: "glm-4.7",
    slug: "z-ai/glm-4.7",
    pool: ["deepinfra", "novita", "z-ai"],
    ceiling: { prompt: 0.65, completion: 2.25 },
    requiresCacheReads: true,
    dataCollection: "deny",
  },
  {
    id: "glm-5.3-flash",
    slug: "z-ai/glm-5.3-flash",
    pool: ["z-ai", "novita", "deepinfra", "gmicloud", "makora"],
    ceiling: { prompt: 0.20, completion: 0.60 },
    requiresCacheReads: true,
    dataCollection: "deny",
  },
  {
    id: "glm-5.3-flash-economy",
    slug: "z-ai/glm-5.3-flash",
    pool: ["relace", "z-ai", "novita", "deepinfra"],
    ceiling: { prompt: 0.20, completion: 0.60 },
    requiresCacheReads: true,
    dataCollection: "deny",
  },
  {
    id: "ling-3.0-flash",
    slug: "inclusionai/ling-3.0-flash",
    pool: [],
    ceiling: { prompt: 0.10, completion: 0.30 },
    requiresCacheReads: false,
    dataCollection: "deny",
  },
  {
    id: "qwen3.8-flash",
    slug: "qwen/qwen3.8-flash",
    pool: [],
    ceiling: { prompt: 0.20, completion: 0.60 },
    requiresCacheReads: false,
    dataCollection: "deny",
  },
  { id: "mimo-v2.5", slug: "xiaomi/mimo-v2.5", pool: [], ceiling: null, requiresCacheReads: false, dataCollection: "deny" },
  { id: "mimo-v2.5-pro", slug: "xiaomi/mimo-v2.5-pro", pool: [], ceiling: null, requiresCacheReads: false, dataCollection: "deny" },
  { id: "minimax-m2-her", slug: "minimax/minimax-m2-her", pool: [], ceiling: null, requiresCacheReads: false, dataCollection: "deny" },
  { id: "ling-3.0-flash-free", slug: "inclusionai/ling-3.0-flash:free", pool: [], ceiling: null, requiresCacheReads: false, dataCollection: "deny" },
  { id: "minimax-m2.5-free", slug: "minimax/minimax-m2.5:free", pool: [], ceiling: null, requiresCacheReads: false, dataCollection: "deny" },
];

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Title": "Afterglow provider pool audit" },
  });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/**
 * A provider's routing slug, from whatever the endpoint object calls it.
 *
 * OpenRouter returns a human-readable provider NAME in some shapes and a slug
 * in others, and `provider.only` takes the slug. Comparing across the two
 * namespaces silently reports every pool member as missing, which would make
 * this audit fail loudly and wrongly — the worst kind of monitoring.
 */
function slugOf(endpoint) {
  const candidate = endpoint.provider_slug ?? endpoint.tag ?? endpoint.provider_name ?? endpoint.name ?? "";
  return String(candidate).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const money = (value) => (value === null || value === undefined ? null : Number(value) * 1_000_000);

function endpointFacts(endpoint) {
  const pricing = endpoint.pricing ?? {};
  return {
    slug: slugOf(endpoint),
    name: endpoint.provider_name ?? endpoint.name ?? "—",
    promptUsdPerMillion: money(pricing.prompt),
    completionUsdPerMillion: money(pricing.completion),
    /*
     * The field that decides whether the whole cache strategy applies here.
     * Absent or zero-priced-but-undeclared is NOT the same as "free cache
     * reads": it means this endpoint publishes no cache-read rate, and a
     * conversation on it pays fresh prices for every repeated byte.
     */
    cachedReadUsdPerMillion: money(pricing.input_cache_read ?? pricing.cached_input ?? null),
    cacheWriteUsdPerMillion: money(pricing.input_cache_write ?? null),
    contextTokens: endpoint.context_length ?? null,
    maxOutputTokens: endpoint.max_completion_tokens ?? null,
    uptimeLast30m: endpoint.uptime_last_30m ?? null,
    /* Whether this endpoint may train on a prompt, per OpenRouter's own field. */
    trainsOnPrompts: endpoint.data_policy?.training ?? null,
    retainsPrompts: endpoint.data_policy?.retainsPrompts ?? endpoint.data_policy?.retains_prompts ?? null,
    status: endpoint.status ?? null,
  };
}

async function auditTarget(target) {
  const [author, ...rest] = target.slug.split("/");
  const model = rest.join("/");
  let endpoints = [];
  let modelMissing = false;
  try {
    const data = await get(`/models/${encodeURIComponent(author)}/${encodeURIComponent(model)}/endpoints`);
    endpoints = (data?.data?.endpoints ?? []).map(endpointFacts);
  } catch (error) {
    modelMissing = true;
    endpoints = [];
    if (!asJson) console.error(`  ! ${target.slug}: ${error.message}`);
  }

  const problems = [];
  if (modelMissing) problems.push(`slug ${target.slug} could not be read from the catalogue`);

  const byslug = new Map(endpoints.map((endpoint) => [endpoint.slug, endpoint]));
  for (const member of target.pool) {
    const endpoint = byslug.get(member);
    if (!endpoint) {
      /*
       * THE OUTAGE CASE. In `cost_guarded` this slug is inside `provider.only`,
       * so a name that no longer resolves does not degrade the route — it
       * removes an endpoint from a set that may then be empty.
       */
      problems.push(`pool member "${member}" does not serve ${target.slug}`);
      continue;
    }
    if (target.requiresCacheReads && endpoint.cachedReadUsdPerMillion === null) {
      problems.push(`pool member "${member}" publishes no cache-read price — it satisfies the ceiling and defeats the objective`);
    }
    if (target.ceiling) {
      if (endpoint.promptUsdPerMillion !== null && endpoint.promptUsdPerMillion > target.ceiling.prompt) {
        problems.push(`pool member "${member}" prompt $${endpoint.promptUsdPerMillion.toFixed(3)}/M is above the $${target.ceiling.prompt}/M ceiling`);
      }
      if (endpoint.completionUsdPerMillion !== null && endpoint.completionUsdPerMillion > target.ceiling.completion) {
        problems.push(`pool member "${member}" completion $${endpoint.completionUsdPerMillion.toFixed(3)}/M is above the $${target.ceiling.completion}/M ceiling`);
      }
    }
    if (target.dataCollection === "deny" && endpoint.trainsOnPrompts === true) {
      // Not fatal by itself — `data_collection: "deny"` excludes it at request
      // time — but a pool whose members are mostly excluded is a pool that is
      // about to run out of endpoints without saying so.
      problems.push(`pool member "${member}" trains on prompts and will be excluded by the privacy floor`);
    }
  }

  if (target.ceiling) {
    const eligible = endpoints.filter((endpoint) =>
      (endpoint.promptUsdPerMillion ?? 0) <= target.ceiling.prompt
      && (endpoint.completionUsdPerMillion ?? 0) <= target.ceiling.completion);
    if (!eligible.length) problems.push("no endpoint at all is under the declared ceiling");
  }

  return { ...target, endpoints, problems };
}

const wanted = option("model", "");
const selected = wanted ? targets.filter((target) => target.id === wanted) : targets;
if (!selected.length) {
  console.error(`No catalogue entry named "${wanted}". Known: ${targets.map((target) => target.id).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const target of selected) results.push(await auditTarget(target));

if (asJson) {
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), results }, null, 2));
} else {
  for (const result of results) {
    console.log(`\n${result.id}  (${result.slug})`);
    if (!result.endpoints.length) console.log("  no endpoints returned");
    for (const endpoint of result.endpoints) {
      const cache = endpoint.cachedReadUsdPerMillion === null ? "no cache-read price" : `cache $${endpoint.cachedReadUsdPerMillion.toFixed(4)}/M`;
      const pool = result.pool.includes(endpoint.slug) ? "POOL" : "    ";
      console.log(`  ${pool} ${endpoint.slug.padEnd(16)} in $${(endpoint.promptUsdPerMillion ?? 0).toFixed(3)}/M  out $${(endpoint.completionUsdPerMillion ?? 0).toFixed(3)}/M  ${cache}  ctx ${endpoint.contextTokens ?? "?"}  trains ${endpoint.trainsOnPrompts ?? "?"}`);
    }
    for (const problem of result.problems) console.log(`  ✗ ${problem}`);
    if (!result.problems.length) console.log("  ✓ pool is affordable, cache-capable and present");
  }
  console.log("");
}

process.exit(results.some((result) => result.problems.length) ? 1 : 0);
