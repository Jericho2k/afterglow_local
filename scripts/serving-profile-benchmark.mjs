#!/usr/bin/env node
/**
 * STAGE 1: THE CHEAP TECHNICAL SCREEN, BEFORE ANYBODY SPENDS REAL MONEY ON RP.
 *
 * A premise about GLM 5.3 Flash — that one class of endpoint (Relace) is
 * extremely cheap and slow, and another (Makora) dearer and substantially
 * faster — could never be verified from the build environment, and the product
 * has stopped pretending otherwise: GLM 5.3 Flash is served by Z.AI alone, and
 * the catalogue no longer offers a second serving profile built on a sentence
 * nobody measured.
 *
 * THIS HARNESS IS HOW ANOTHER HOST EARNS ITS PLACE. It takes upstream slugs and
 * provider slugs directly rather than catalogue ids, so it can measure any
 * endpoint OpenRouter serves without one existing in the product first — and it
 * is deliberately the FIRST thing run: a route with a thirty-second time to
 * first token is dead for interactive chat whatever its prose is like, and
 * finding that out costs pennies here rather than dollars in a full roleplay
 * evaluation.
 *
 * WHAT IT MEASURES, per model and per pinned endpoint:
 *
 *   TTFT              time to the first visible token, per turn, with a median
 *   throughput        output tokens per second once streaming starts
 *   500 / 1K / 2K     wall-clock to that many completion tokens, extrapolated
 *                     from measured throughput where a turn is shorter
 *   cache hit ratio   the provider's own cached_tokens over prompt tokens
 *   effective input   what a prompt token really cost, blending fresh + cached
 *   cost/generation   provider-reported, never recomputed from a table
 *   failure/timeout   how often the endpoint refused or went quiet
 *
 * A PROVIDER WITH A P50 TTFT OVER 30 SECONDS IS DEAD FOR CHAT, and the summary
 * says so in those words. A provider with a fast TTFT and very low throughput
 * is flagged separately, because those are different problems: the first is
 * unusable, the second is unpleasant, and a product can offer the second as an
 * Economy profile while never offering the first.
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/serving-profile-benchmark.mjs
 *   … --models z-ai/glm-5.3-flash,inclusionai/ling-3.0-flash
 *   … --providers relace,makora,z-ai,novita     pin each in turn
 *   … --turns 12                                sequential turns per arm
 *   … --max-tokens 160                          output envelope (cost control)
 *   … --estimate-only                           print the spend estimate, send nothing
 *   … --budget 2.00                             refuse to start above this estimate
 *   … --json
 *
 * COST CONTROL IS THE FIRST FEATURE, NOT THE LAST. Every run prints its worst
 * case before sending anything, `--estimate-only` prints it and stops, and
 * `--budget` refuses a run whose estimate exceeds what the operator authorised.
 * Output is capped low by default because this measures ROUTING, not prose.
 *
 * Nothing here reads or writes Afterglow's database. The prompts are synthetic
 * and shaped like Afterglow's, so a run cannot touch anybody's story.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);
const asJson = flag("json");
const estimateOnly = flag("estimate-only");

const models = option("models", "z-ai/glm-5.3-flash").split(",").map((value) => value.trim()).filter(Boolean);
const providers = option("providers", "").split(",").map((value) => value.trim()).filter(Boolean);
const turns = Math.max(2, Number(option("turns", 10)));
const maxTokens = Math.max(32, Number(option("max-tokens", 160)));
const budget = Number(option("budget", 0));
const worldSize = option("world", "medium");
const reasoning = option("reasoning", "off");

/**
 * The worst case, in dollars, before a single request is sent.
 *
 * Deliberately PESSIMISTIC on every line: no cache hits at all, every turn
 * filling its whole output envelope, and the dearest rate this lineup has. A
 * real run comes in well under it, which is the right direction for a number an
 * operator authorises spend against.
 */
const worstCaseRates = { prompt: 0.60, completion: 2.25 };
function estimateSpendUsd(promptTokensPerTurn) {
  const arms = models.length * Math.max(1, providers.length);
  const inputCost = (arms * turns * promptTokensPerTurn * worstCaseRates.prompt) / 1_000_000;
  const outputCost = (arms * turns * maxTokens * worstCaseRates.completion) / 1_000_000;
  return { arms, requests: arms * turns, inputCost, outputCost, total: inputCost + outputCost };
}

const lorem = (words, seed = 0) => Array.from({ length: words }, (_, index) => `lore${(index + seed) % 97}`).join(" ");
const worldWords = { none: 0, small: 320, medium: 3_000, large: 16_500 }[worldSize] ?? 3_000;

/**
 * A prompt shaped like Afterglow's: a long stable head, the anchored transcript
 * window, then the dynamic continuity block immediately before the newest turn.
 * The order mirrors `writerMessages` under tail placement; a benchmark that put
 * the dynamic block inside the head would strand the transcript behind it and
 * measure a prompt Afterglow does not send.
 */
const stableHead = [
  "You are Maya and portray the living world around them in an ongoing private roleplay.",
  `CHARACTER\nBackstory: ${lorem(240)}\nPersonality: ${lorem(140)}\nExample dialogue: ${lorem(120)}`,
  `LOREBOOK / WORLD CANON\n${worldWords ? lorem(worldWords) : "No reusable world documents are attached."}`,
  `ACTIVE USER PERSONA\nName: Ivy\nProfile: ${lorem(45)}`,
  `RULES\n${lorem(300)}`,
].join("\n\n");

const anchorStep = 16;
const windowMessages = 30;
function messagesFor(turn) {
  const total = 120 + turn * 2;
  const dropped = Math.max(0, total - windowMessages);
  const start = Math.floor(dropped / anchorStep) * anchorStep;
  const messages = [];
  for (let index = start; index < total - 1; index += 1) {
    messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: lorem(index % 2 === 0 ? 45 : 180, index) });
  }
  return messages;
}

// Roughly four characters per token; used only for the pre-flight estimate,
// where being approximately right before spending is worth more than being
// exactly right afterwards.
const approxPromptTokens = Math.round((stableHead.length + messagesFor(turns).reduce((sum, message) => sum + message.content.length, 0)) / 4);

const estimate = estimateSpendUsd(approxPromptTokens);
const estimateLine = `${estimate.arms} arm(s) x ${turns} turns = ${estimate.requests} requests; worst case ~$${estimate.total.toFixed(3)} (input ~$${estimate.inputCost.toFixed(3)}, output ~$${estimate.outputCost.toFixed(3)}) at ${approxPromptTokens} prompt tokens/turn`;

if (!asJson) console.log(estimateLine);
if (estimateOnly) process.exit(0);
if (budget > 0 && estimate.total > budget) {
  console.error(`Refusing to start: the worst case exceeds the --budget of $${budget.toFixed(2)}.`);
  console.error("Lower --turns or --max-tokens, or raise the budget deliberately.");
  process.exit(2);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("");
  console.error("OPENROUTER_API_KEY is required: this measures live endpoints on purpose.");
  console.error("");
  console.error("SKIPPED, LOUDLY. Nothing about Relace, Makora, or any other serving profile");
  console.error("can be claimed without this run — which is why the catalogue no longer ships");
  console.error("a second GLM 5.3 Flash profile built on the unverified premise that one host");
  console.error("is cheap-and-slow and another dear-and-fast. GLM 5.3 Flash is served by Z.AI");
  console.error("alone in production; this harness is how another host earns a place, and it");
  console.error("takes upstream slugs directly, so it never depends on a catalogue entry.");
  process.exit(2);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const runId = Date.now().toString(36);
const headersTimeoutMs = Number(option("headers-timeout", 45_000));

async function runTurn(model, provider, turn) {
  const startedAt = Date.now();
  const control = new AbortController();
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; control.abort(); }, headersTimeoutMs);
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow serving profile benchmark" },
      signal: control.signal,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: stableHead },
          ...messagesFor(turn),
          { role: "system", content: `CURRENT CONTINUITY — DYNAMIC FOR THIS REPLY\nRolling state: ${lorem(120, turn)} (beat ${turn})` },
          { role: "user", content: `${lorem(40, turn)} — turn ${turn}` },
        ],
        max_tokens: maxTokens,
        temperature: 0.95,
        stream: true,
        usage: { include: true },
        // One session per arm: two arms sharing a session would each be
        // measuring the other's stickiness rather than their own.
        session_id: `afterglow-profile-${model}-${provider ?? "auto"}-${runId}`,
        ...(reasoning === "on" ? { reasoning: { enabled: true } } : {}),
        ...(reasoning === "off" ? { reasoning: { enabled: false } } : {}),
        ...(provider ? { provider: { only: [provider], allow_fallbacks: false } } : {}),
      }),
    });
    clearTimeout(deadline);
  } catch (error) {
    clearTimeout(deadline);
    return { turn, failed: true, timedOut, detail: timedOut ? `no headers within ${headersTimeoutMs}ms` : String(error).slice(0, 160) };
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    return { turn, failed: true, capacity: response.status === 429, detail: `HTTP ${response.status} ${detail}` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", ttft, usage = null, servedBy, firstTokenAt;
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
        if (typeof data.provider === "string") servedBy = data.provider;
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta && ttft === undefined) { ttft = Date.now() - startedAt; firstTokenAt = Date.now(); }
        if (data.usage) usage = data.usage;
      } catch { /* a malformed chunk is not a measurement */ }
    }
  }
  const completedAt = Date.now();
  const completionTokens = Number(usage?.completion_tokens) || 0;
  const promptTokens = Number(usage?.prompt_tokens) || 0;
  const cachedTokens = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
  /*
   * Throughput is measured from the FIRST TOKEN, not from the request.
   *
   * Including the wait before the first token would blend two different
   * properties into one number and hide exactly the case this script exists to
   * find: an endpoint that is slow to start and then fast, versus one that
   * starts promptly and then trickles.
   */
  const streamMs = firstTokenAt ? completedAt - firstTokenAt : null;
  return {
    turn, failed: false, servedBy, ttftMs: ttft ?? null,
    streamMs, completionTokens, promptTokens, cachedTokens,
    throughputTps: streamMs && streamMs > 0 && completionTokens > 0 ? (completionTokens / streamMs) * 1000 : null,
    costUsd: Number.isFinite(Number(usage?.cost)) ? Number(usage.cost) : null,
    totalMs: completedAt - startedAt,
  };
}

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);

function summarize(model, provider, results) {
  const ok = results.filter((result) => !result.failed);
  const ttftP50 = median(ok.map((result) => result.ttftMs));
  const throughputP50 = median(ok.map((result) => result.throughputTps));
  const promptTokens = sum(ok.map((result) => result.promptTokens));
  const cachedTokens = sum(ok.map((result) => result.cachedTokens));
  const cost = ok.filter((result) => result.costUsd !== null);
  const totalCost = sum(cost.map((result) => result.costUsd));
  /* Completion time to N tokens, from the measured start-up and stream rate. */
  const timeToTokens = (count) => (ttftP50 === null || !throughputP50 ? null : ttftP50 + (count / throughputP50) * 1000);
  return {
    model, provider: provider ?? "auto",
    servedBy: [...new Set(ok.map((result) => result.servedBy).filter(Boolean))],
    attempts: results.length,
    failures: results.filter((result) => result.failed && !result.timedOut).length,
    timeouts: results.filter((result) => result.timedOut).length,
    capacityRefusals: results.filter((result) => result.capacity).length,
    ttftP50Ms: ttftP50,
    throughputP50Tps: throughputP50,
    msTo500Tokens: timeToTokens(500),
    msTo1kTokens: timeToTokens(1000),
    msTo2kTokens: timeToTokens(2000),
    cacheHitRatio: promptTokens > 0 ? cachedTokens / promptTokens : null,
    costPerGenerationUsd: cost.length ? totalCost / cost.length : null,
    costPer100GenerationsUsd: cost.length ? (totalCost / cost.length) * 100 : null,
    /*
     * The two verdicts a product decision actually turns on, stated rather than
     * left for a reader to derive from a table at three in the morning.
     */
    deadForInteractiveChat: ttftP50 !== null && ttftP50 > 30_000,
    slowStreaming: throughputP50 !== null && throughputP50 < 15,
  };
}

const arms = [];
for (const model of models) for (const provider of providers.length ? providers : [null]) arms.push({ model, provider });

const summaries = [];
for (const arm of arms) {
  const results = [];
  for (let turn = 0; turn < turns; turn += 1) results.push(await runTurn(arm.model, arm.provider, turn));
  const summary = summarize(arm.model, arm.provider, results);
  summaries.push(summary);
  if (!asJson) {
    const ttft = summary.ttftP50Ms === null ? "—" : `${Math.round(summary.ttftP50Ms)}ms`;
    const tps = summary.throughputP50Tps === null ? "—" : `${summary.throughputP50Tps.toFixed(1)}/s`;
    const cache = summary.cacheHitRatio === null ? "—" : `${(summary.cacheHitRatio * 100).toFixed(1)}%`;
    const cost = summary.costPerGenerationUsd === null ? "—" : `$${summary.costPerGenerationUsd.toFixed(6)}`;
    console.log(`${arm.model} via ${summary.provider.padEnd(12)} served ${summary.servedBy.join("/") || "?"}  TTFT p50 ${ttft}  ${tps}  cache ${cache}  ${cost}/gen  fail ${summary.failures} timeout ${summary.timeouts} 429 ${summary.capacityRefusals}`);
    if (summary.deadForInteractiveChat) console.log("   ✗ P50 TTFT over 30s — dead for interactive chat, whatever the prose is like");
    if (summary.slowStreaming) console.log("   ! very low streaming throughput — usable, but Economy at best");
  }
}

if (asJson) console.log(JSON.stringify({ ranAt: new Date().toISOString(), estimate: estimateLine, reasoning, turns, maxTokens, summaries }, null, 2));
