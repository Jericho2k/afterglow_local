#!/usr/bin/env node
/**
 * WHICH `:free` ROUTES ARE ACTUALLY FIT TO PUT A PRIVATE ROLEPLAY THROUGH.
 *
 * "It costs nothing" is the least interesting thing about a free endpoint. The
 * questions that decide whether one belongs in Afterglow's catalogue are:
 *
 *   CAN IT HOLD A CONVERSATION AT ALL? Some free routes are text-completion or
 *   tool-shaped and answer a chat request with nothing useful.
 *   IS THE CONTEXT ENOUGH? A roleplay with a World attached is not small, and a
 *   route that 400s on a long prompt is a broken model in the picker.
 *   DOES IT START IN TIME? A P50 time to first token over thirty seconds is
 *   dead for interactive chat, free or not.
 *   DOES IT STREAM AT A READABLE RATE?
 *   IS IT UP?
 *   AND — THE ONE THAT IS NOT ABOUT PERFORMANCE — WHAT DOES THE PROVIDER DO
 *   WITH THE PROMPT? OpenRouter's account settings distinguish free endpoints
 *   that may TRAIN on inputs from free endpoints that may PUBLISH prompts.
 *   A route in the second class has no business being an ordinary chat model
 *   for private conversations at any price, including zero.
 *
 * This script answers all six against the live catalogue and prints the SQL that
 * enables what passed. Curation stays a HUMAN decision: the SQL is printed, not
 * executed, because "the benchmark said yes" is not the same as "we are willing
 * to put readers' stories through it".
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/free-route-screen.mjs
 *   … --discover                list every :free route the catalogue offers
 *   … --routes a:free,b:free    screen specific slugs (default: the curated set)
 *   … --probe                   actually send one short chat request per route
 *   … --turns 3                 probe turns per route (default 3)
 *   … --json
 *
 * WITHOUT `--probe` this makes no inference calls at all and screens on
 * catalogue metadata alone — context, pricing, uptime, data policy. That is the
 * cheap first pass and it eliminates most candidates. `--probe` adds latency and
 * throughput, which cannot be read from a catalogue.
 *
 * A FREE PROBE IS NOT FREE OF CONSEQUENCE. Every request counts against the
 * platform account's daily free allowance — OpenRouter counts failed attempts
 * too — so the probe is short, capped, and off by default.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);
const asJson = flag("json");

/**
 * The routes the catalogue currently declares, mirrored from
 * src/lib/provider.ts by hand. `--discover` is how the list grows: OpenRouter's
 * free lineup changes weekly and a hardcoded list here would be a second thing
 * to go stale.
 */
const curated = ["inclusionai/ling-3.0-flash:free", "minimax/minimax-m2.5:free"];

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required: free routes are screened against the LIVE catalogue.");
  console.error("");
  console.error("SKIPPED, LOUDLY. The two routes in the catalogue were confirmed through a search");
  console.error("index rather than through this API, and the brief's other candidates — MiniMax");
  console.error("M2.7, MiniMax M3 and Nemotron 3 Ultra — could not be confirmed to exist as :free");
  console.error("routes at all, which is why they are ABSENT from the catalogue rather than");
  console.error("guessed at. A wrong slug is a route that 404s for every reader on the free tier.");
  process.exit(2);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const turns = Math.max(1, Number(option("turns", 3)));

async function get(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "X-Title": "Afterglow free route screen" },
  });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

/** The floors a route has to clear. Deliberately the same ones the app enforces. */
const floors = {
  minContextTokens: Number(option("min-context", 32_768)),
  maxTtftMs: Number(option("max-ttft", 30_000)),
  minThroughputTps: Number(option("min-throughput", 15)),
  minUptime: Number(option("min-uptime", 0.9)),
};

const catalogue = await get("/models");
const allModels = catalogue?.data ?? [];

if (flag("discover")) {
  const free = allModels.filter((model) => String(model.id).endsWith(":free"));
  if (asJson) {
    console.log(JSON.stringify(free.map((model) => ({ id: model.id, context: model.context_length, modality: model.architecture?.modality })), null, 2));
  } else {
    console.log(`${free.length} free routes in the live catalogue:\n`);
    for (const model of free) console.log(`  ${String(model.id).padEnd(48)} ctx ${model.context_length ?? "?"}  ${model.architecture?.modality ?? "?"}`);
    console.log("\nScreen the interesting ones with --routes a,b --probe");
  }
  process.exit(0);
}

const routes = option("routes", curated.join(",")).split(",").map((value) => value.trim()).filter(Boolean);

async function probe(slug) {
  const results = [];
  for (let turn = 0; turn < turns; turn += 1) {
    const startedAt = Date.now();
    let response;
    const control = new AbortController();
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; control.abort(); }, floors.maxTtftMs + 15_000);
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow free route screen" },
        signal: control.signal,
        body: JSON.stringify({
          model: slug,
          messages: [
            { role: "system", content: "You are Maya, in an ongoing private roleplay. Reply in character, two or three sentences." },
            { role: "user", content: `The rain has not stopped since Tuesday. (probe ${turn})` },
          ],
          max_tokens: 120,
          temperature: 0.9,
          stream: true,
          usage: { include: true },
        }),
      });
      clearTimeout(deadline);
    } catch (error) {
      clearTimeout(deadline);
      results.push({ failed: true, timedOut, detail: String(error).slice(0, 140) });
      continue;
    }
    if (!response.ok) {
      results.push({ failed: true, capacity: response.status === 429, detail: `HTTP ${response.status}` });
      continue;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", ttft, firstTokenAt, usage = null, text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const chunk = line.slice(6).trim();
        if (!chunk || chunk === "[DONE]") continue;
        try {
          const data = JSON.parse(chunk);
          const delta = data.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta) { ttft ??= Date.now() - startedAt; firstTokenAt ??= Date.now(); text += delta; }
          if (data.usage) usage = data.usage;
        } catch { /* a malformed chunk is not a measurement */ }
      }
    }
    const streamMs = firstTokenAt ? Date.now() - firstTokenAt : null;
    const completionTokens = Number(usage?.completion_tokens) || 0;
    results.push({
      failed: false, ttftMs: ttft ?? null,
      throughputTps: streamMs && streamMs > 0 && completionTokens > 0 ? (completionTokens / streamMs) * 1000 : null,
      // Whether it produced PROSE, not merely a 200. A route that answers a
      // roleplay turn with an empty string or a tool call is not a chat model.
      producedProse: text.trim().length > 20,
    });
  }
  return results;
}

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const screened = [];
for (const slug of routes) {
  const listing = allModels.find((model) => model.id === slug);
  const failures = [];
  if (!listing) failures.push(`not in the live catalogue — the slug is wrong or the route is gone`);

  let endpoints = [];
  if (listing) {
    const [author, ...rest] = slug.split("/");
    try {
      const data = await get(`/models/${encodeURIComponent(author)}/${encodeURIComponent(rest.join("/"))}/endpoints`);
      endpoints = data?.data?.endpoints ?? [];
    } catch (error) { failures.push(`endpoints unreadable: ${error.message}`); }
  }

  const context = listing?.context_length ?? null;
  if (context !== null && context < floors.minContextTokens) {
    failures.push(`context ${context} is below the ${floors.minContextTokens}-token floor a story with a World needs`);
  }
  const modality = listing?.architecture?.modality ?? "";
  if (modality && !String(modality).includes("text")) failures.push(`modality "${modality}" is not a text chat route`);

  /*
   * THE PRIVACY FINDINGS, reported per endpoint and never averaged.
   *
   * OpenRouter is explicit that what happens to a prompt is governed by the
   * DOWNSTREAM provider's policy, not by OpenRouter's own settings, so a route
   * whose endpoints disagree is a route where the answer depends on which host
   * served the turn. That is worth seeing rather than summarising away.
   */
  const privacy = endpoints.map((endpoint) => ({
    provider: endpoint.provider_name ?? endpoint.name ?? "?",
    trainsOnPrompts: endpoint.data_policy?.training ?? null,
    publishesPrompts: endpoint.data_policy?.canPublish ?? endpoint.data_policy?.can_publish ?? null,
    retainsPrompts: endpoint.data_policy?.retainsPrompts ?? endpoint.data_policy?.retains_prompts ?? null,
    uptimeLast30m: endpoint.uptime_last_30m ?? null,
  }));
  if (privacy.length && privacy.every((endpoint) => endpoint.trainsOnPrompts === true)) {
    failures.push("every endpoint trains on prompts — the privacy floor would leave nothing to route to");
  }
  if (privacy.some((endpoint) => endpoint.publishesPrompts === true)) {
    failures.push("an endpoint may PUBLISH prompts — exclude from normal chat regardless of price");
  }
  const uptime = median(privacy.map((endpoint) => endpoint.uptimeLast30m));
  if (uptime !== null && uptime < floors.minUptime) failures.push(`uptime ${(uptime * 100).toFixed(0)}% is below the ${(floors.minUptime * 100).toFixed(0)}% floor`);

  let probed = null;
  if (flag("probe") && listing) {
    const results = await probe(slug);
    const ok = results.filter((result) => !result.failed);
    probed = {
      attempts: results.length,
      failures: results.filter((result) => result.failed).length,
      ttftP50Ms: median(ok.map((result) => result.ttftMs)),
      throughputP50Tps: median(ok.map((result) => result.throughputTps)),
      producedProse: ok.some((result) => result.producedProse),
    };
    if (!probed.producedProse) failures.push("no probe produced usable prose — not a chat model for this purpose");
    if (probed.ttftP50Ms !== null && probed.ttftP50Ms > floors.maxTtftMs) {
      failures.push(`P50 TTFT ${Math.round(probed.ttftP50Ms)}ms is over the ${floors.maxTtftMs}ms interactive floor — reject`);
    }
    if (probed.throughputP50Tps !== null && probed.throughputP50Tps < floors.minThroughputTps) {
      // Not a rejection: slow streaming is deprioritised rather than hidden,
      // because it is a trade a reader is allowed to make.
      probed.slowStreaming = true;
    }
  }

  screened.push({ slug, context, modality, privacy, probed, failures, passed: failures.length === 0 });
}

if (asJson) {
  console.log(JSON.stringify({ screenedAt: new Date().toISOString(), floors, screened }, null, 2));
} else {
  for (const route of screened) {
    console.log(`\n${route.slug}  ctx ${route.context ?? "?"}  ${route.modality || "?"}`);
    for (const endpoint of route.privacy) {
      console.log(`   ${String(endpoint.provider).padEnd(20)} trains ${endpoint.trainsOnPrompts ?? "?"}  publishes ${endpoint.publishesPrompts ?? "?"}  retains ${endpoint.retainsPrompts ?? "?"}  uptime ${endpoint.uptimeLast30m ?? "?"}`);
    }
    if (route.probed) {
      console.log(`   probe: TTFT p50 ${route.probed.ttftP50Ms === null ? "—" : `${Math.round(route.probed.ttftP50Ms)}ms`}  ${route.probed.throughputP50Tps === null ? "—" : `${route.probed.throughputP50Tps.toFixed(1)}/s`}  failures ${route.probed.failures}/${route.probed.attempts}${route.probed.slowStreaming ? "  (slow streaming — deprioritise)" : ""}`);
    }
    for (const failure of route.failures) console.log(`   ✗ ${failure}`);
    if (route.passed) console.log("   ✓ clears every floor");
  }

  const passed = screened.filter((route) => route.passed);
  console.log("\n-- Curation is a human decision. Review, then apply:\n");
  for (const route of screened) {
    const id = route.slug.replace(/[^a-z0-9.:-]/gi, "");
    console.log(`-- ${route.slug}: ${route.passed ? "passed" : route.failures.join("; ")}`);
    console.log(`-- INSERT INTO curated_model_routes (model_id,enabled) VALUES ('<catalogue-id-for-${id}>',${route.passed}) ON CONFLICT (model_id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now();`);
  }
  console.log(`\n${passed.length}/${screened.length} routes cleared every floor.`);
}

process.exit(screened.some((route) => !route.passed) ? 1 : 0);
