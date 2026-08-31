#!/usr/bin/env node
/**
 * WHAT GLM 4.7 ACTUALLY COSTS, PER ROUTING STRATEGY, AGAINST THE LIVE ENDPOINT.
 *
 * Everything this sprint shipped rests on documented OpenRouter semantics and
 * on offline measurement of Afterglow's own prompt. Neither of those can
 * establish the two facts that decide whether the work paid off:
 *
 *   DOES THE CACHE ACTUALLY HIT? A stable prefix is necessary and not
 *   sufficient. Only the provider's own `cached_tokens` says whether the
 *   discount arrived.
 *
 *   DOES `sort: "price"` FIGHT SESSION STICKINESS? OpenRouter documents that
 *   setting `order` turns its routing off, and is silent about `sort`. That
 *   silence is the reason `cost_optimized` is not the shipped default, and
 *   arm D-price below is the experiment that would settle it.
 *
 * So this script exists to be run with a real key, and it prints numbers that
 * can contradict the design. A run where cost_guarded shows more provider
 * switches than pinned DeepInfra is a result, not a bug in the script.
 *
 * ARMS (§12 of the sprint brief)
 *   A  deepinfra   pinned, the cheapest eligible endpoint
 *   B  z-ai        pinned, the incumbent
 *   C  auto        today's behaviour: session_id, no provider block
 *   D  guarded     what production now sends: session_id + max_price ceiling
 *   D-price        guarded plus sort:"price" — the unverified variant
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/glm-routing-benchmark.mjs
 *   … --arms a,b,c,d           choose arms (default: all five)
 *   … --turns 24               sequential turns per arm (default 20)
 *   … --world large            how much stable prompt to carry
 *   … --reasoning              §14: run each arm with thinking on and off
 *   … --max-tokens 900         §15: raise the output envelope (default 120)
 *
 * COST CONTROL. Output is capped at 120 tokens by default, because this
 * measures CACHE AND ROUTING and not prose — the input side is what is being
 * studied and output tokens are the expensive half. A default run is five arms
 * of twenty turns; at DeepInfra's rates that is cents, not dollars. Raise
 * --max-tokens only for the length study, which is a different question.
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

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required: this script measures a live endpoint on purpose.");
  console.error("Without it nothing about the economics is proven, and the offline analysis in");
  console.error("tests/prompt-cacheability.test.ts is the most that can honestly be claimed.");
  process.exit(1);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const model = option("model", "z-ai/glm-4.7");
const turns = Number(option("turns", 20));
const maxTokens = Number(option("max-tokens", 120));
const worldSize = option("world", "medium");
const requestedArms = option("arms", "a,b,c,d,d-price").split(",").map((value) => value.trim().toLowerCase());

/**
 * The ceiling production sends, mirrored from `glm-4.7`'s catalogue entry.
 * Kept in step by hand deliberately: this script must be able to send a
 * DIFFERENT policy from production's in order to compare against it.
 */
const ceiling = { prompt: 0.65, completion: 2.25 };

/** List prices per million, for splitting a reported total into its halves. */
const endpointPricing = {
  DeepInfra: { input: 0.40, cached: 0.08, output: 1.75 },
  Novita: { input: 0.54, cached: 0.099, output: 1.98 },
  "Z.AI": { input: 0.60, cached: 0.11, output: 2.20 },
};

const arms = {
  a: { label: "A pinned deepinfra", provider: { only: ["deepinfra"], allow_fallbacks: false } },
  b: { label: "B pinned z-ai", provider: { only: ["z-ai"], allow_fallbacks: false } },
  c: { label: "C auto (today)", provider: undefined },
  d: { label: "D guarded (shipped)", provider: { allow_fallbacks: true, max_price: ceiling } },
  "d-price": { label: "D+ guarded + sort:price", provider: { allow_fallbacks: true, max_price: ceiling, sort: "price" } },
};

const lorem = (words, seed = 0) => Array.from({ length: words }, (_, index) => `lore${(index + seed) % 97}`).join(" ");
const worldWords = { none: 0, small: 320, medium: 3_000, large: 16_500 }[worldSize] ?? 3_000;

/**
 * A prompt shaped like Afterglow's: a long stable head, the transcript, then
 * the dynamic continuity block immediately before the newest turn.
 *
 * THE ORDER IS THE POINT and it mirrors `writerMessages` under "tail"
 * placement. Putting the continuity block inside the head — where it used to
 * live — strands the whole transcript behind it and measures a different
 * product.
 */
function head() {
  return [
    "You are Maya and portray the living world around them in an ongoing private roleplay.",
    `CHARACTER\nBackstory: ${lorem(240)}\nPersonality: ${lorem(140)}\nExample dialogue: ${lorem(120)}`,
    `LOREBOOK / WORLD CANON\n${worldWords ? lorem(worldWords) : "No reusable world documents are attached."}`,
    `ACTIVE USER PERSONA\nName: Ivy\nProfile: ${lorem(45)}`,
    `RULES\n${lorem(300)}`,
  ].join("\n\n");
}

const stableHead = head();

/**
 * The anchored transcript window.
 *
 * Quantised exactly as `selectAnchoredMessages` quantises it, so the benchmark
 * re-anchors on the same schedule production does. A benchmark whose window
 * slid every turn would measure a prompt Afterglow does not send.
 */
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

function payload(turn, armKey, thinking) {
  const conversation = messagesFor(turn);
  const continuity = `CURRENT CONTINUITY — DYNAMIC FOR THIS REPLY\nRolling state: ${lorem(120, turn)} (beat ${turn})`;
  const arm = arms[armKey];
  return {
    model,
    messages: [
      { role: "system", content: stableHead },
      ...conversation,
      { role: "system", content: continuity },
      { role: "user", content: `${lorem(40, turn)} — turn ${turn}` },
    ],
    max_tokens: maxTokens,
    temperature: 0.95,
    stream: true,
    usage: { include: true },
    // One session per arm and per reasoning setting: two arms sharing a session
    // would each be measuring the other's stickiness.
    session_id: `afterglow-glm-${armKey}-${thinking ?? "default"}-${runId}`,
    ...(thinking === true ? { reasoning: { enabled: true } } : {}),
    ...(thinking === false ? { reasoning: { enabled: false } } : {}),
    ...(arm.provider ? { provider: arm.provider } : {}),
  };
}

const runId = Date.now().toString(36);

async function runTurn(turn, armKey, thinking) {
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow GLM routing benchmark" },
      body: JSON.stringify(payload(turn, armKey, thinking)),
    });
  } catch (error) {
    return { turn, failed: true, detail: String(error).slice(0, 160) };
  }
  if (!response.ok) {
    return { turn, failed: true, detail: `HTTP ${response.status} ${(await response.text()).slice(0, 200)}` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", ttft, usage = null, provider, output = "";
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
        if (typeof data.provider === "string") provider = data.provider;
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) { ttft ??= Date.now() - startedAt; output += delta; }
        if (data.usage) usage = data.usage;
      } catch { /* a malformed chunk is not a measurement */ }
    }
  }

  const promptTokens = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    turn,
    provider: provider ?? "—",
    promptTokens,
    cached,
    ratio: promptTokens ? cached / promptTokens : 0,
    completion: usage?.completion_tokens ?? 0,
    reasoning: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    // Provider-reported, never recomputed. This is the bill.
    cost: typeof usage?.cost === "number" ? usage.cost : null,
    ttft: ttft ?? null,
    total: Date.now() - startedAt,
    chars: output.length,
  };
}

/**
 * Summarise one arm.
 *
 * WARM-UP IS EXCLUDED FROM THE CACHE FIGURE. The first turn of a session
 * cannot hit a cache that does not exist yet, and averaging it in understates
 * a strategy by 1/N for no reason. It is still counted in the totals, because
 * it is still money.
 */
function summarize(label, rows) {
  const ok = rows.filter((row) => !row.failed);
  const failures = rows.length - ok.length;
  if (!ok.length) return { label, failures, empty: true };

  const warm = ok.slice(1);
  const sum = (key, from = ok) => from.reduce((total, row) => total + (row[key] ?? 0), 0);
  const providers = [...new Set(ok.map((row) => row.provider))];
  let switches = 0;
  for (let index = 1; index < ok.length; index += 1) if (ok[index].provider !== ok[index - 1].provider) switches += 1;

  const cost = sum("cost");
  const promptTokens = sum("promptTokens");
  const completion = sum("completion");
  // Split the reported total at the serving endpoint's list output rate, so
  // "effective input $/M" is about the input side alone. Null when the mix of
  // endpoints makes that meaningless.
  const pricing = providers.length === 1 ? endpointPricing[providers[0]] : null;
  const outputCost = pricing ? (completion * pricing.output) / 1e6 : null;
  const inputCost = outputCost === null ? null : cost - outputCost;

  const ttfts = ok.map((row) => row.ttft).filter((value) => typeof value === "number").sort((a, b) => a - b);
  return {
    label, failures,
    turns: ok.length,
    providers, switches,
    warmCacheRatio: warm.length ? sum("cached", warm) / Math.max(1, sum("promptTokens", warm)) : null,
    promptTokens, completion,
    reasoningTokens: sum("reasoning"),
    cost,
    costPerGeneration: cost / ok.length,
    effectiveInputPerMillion: inputCost !== null && inputCost > 0 && promptTokens ? (inputCost / promptTokens) * 1e6 : null,
    outputPerMillionList: pricing?.output ?? null,
    medianTtft: ttfts.length ? ttfts[Math.floor(ttfts.length / 2)] : null,
    medianTotal: ok.map((row) => row.total).sort((a, b) => a - b)[Math.floor(ok.length / 2)],
    avgOutputTokens: completion / ok.length,
  };
}

const usd = (value, digits = 6) => value === null || value === undefined ? "—" : `$${value.toFixed(digits)}`;
const pct = (value) => value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;

const selected = requestedArms.filter((key) => arms[key]);
if (!selected.length) {
  console.error(`No known arms in "${requestedArms.join(",")}". Known: ${Object.keys(arms).join(", ")}`);
  process.exit(1);
}

const reasoningSettings = flag("reasoning") ? [true, false] : [undefined];

console.log(`model=${model}  world=${worldSize} (~${worldWords} words)  turns=${turns}  max_tokens=${maxTokens}  run=${runId}`);
console.log(`arms: ${selected.join(", ")}${flag("reasoning") ? "  ×  reasoning on/off" : ""}\n`);

const summaries = [];
for (const thinking of reasoningSettings) {
  for (const armKey of selected) {
    const suffix = thinking === undefined ? "" : thinking ? " · reasoning ON" : " · reasoning OFF";
    const label = `${arms[armKey].label}${suffix}`;
    console.log(`── ${label}`);
    console.log("turn  prompt   cached   ratio  output  reason      cost  provider          ttft   total");
    const rows = [];
    for (let turn = 1; turn <= turns; turn += 1) {
      const row = await runTurn(turn, armKey, thinking);
      rows.push(row);
      if (row.failed) { console.log(`${String(turn).padStart(4)}  FAILED  ${row.detail}`); continue; }
      console.log([
        String(row.turn).padStart(4), String(row.promptTokens).padStart(8), String(row.cached).padStart(8),
        pct(row.ratio).padStart(8), String(row.completion).padStart(8), String(row.reasoning).padStart(7),
        usd(row.cost).padStart(10), `  ${row.provider.padEnd(16)}`,
        `${row.ttft ?? "—"}ms`.padStart(8), `${row.total}ms`.padStart(8),
      ].join(""));
    }
    summaries.push(summarize(label, rows));
    console.log("");
  }
}

console.log("\n══ SUMMARY ══\n");
console.log("arm                              warm cache   eff. in $/M   $/gen    $/100 gen   out tok  ttft   switches  providers");
for (const row of summaries) {
  if (row.empty) { console.log(`${row.label.padEnd(32)} every turn failed (${row.failures})`); continue; }
  console.log([
    row.label.padEnd(32),
    pct(row.warmCacheRatio).padStart(10),
    (row.effectiveInputPerMillion === null ? "—" : `$${row.effectiveInputPerMillion.toFixed(3)}`).padStart(14),
    usd(row.costPerGeneration, 5).padStart(9),
    usd(row.costPerGeneration * 100, 3).padStart(12),
    row.avgOutputTokens.toFixed(0).padStart(9),
    `${row.medianTtft ?? "—"}ms`.padStart(7),
    String(row.switches).padStart(10),
    `  ${row.providers.join(", ")}${row.failures ? `  (${row.failures} failed)` : ""}`,
  ].join(""));
}

/*
 * The readings that would change what ships, spelled out so a run is
 * interpretable by somebody who did not write the routing.
 */
console.log(`
HOW TO READ THIS

  Warm cache is measured EXCLUDING turn 1, which cannot hit a cache that does
  not exist yet. Near zero on a pinned arm means that endpoint does not cache
  this model, and no routing strategy can rescue it.

  Switches on arms C and D is the drift question. Zero across twenty turns
  means session stickiness held; anything else means a conversation moved, and
  every move is a cold prefix paid at the fresh rate.

  D+ against D is the one open design question. If D+ shows MORE switches than
  D, then sort:"price" is overriding session stickiness, and cost_optimized
  must stay off the default. If it shows the same switches and a lower cost,
  PROVIDER_ROUTING_MODE=cost_optimized is the better default.

  A against B settles DeepInfra versus Z.AI at equal cache. Compare effective
  input $/M and $/100 generations, not the raw totals — the arms may not have
  produced the same number of output tokens.

  With --reasoning, compare reason tokens and $/gen between the ON and OFF
  rows of the same arm. Reasoning tokens bill as OUTPUT, at output prices, and
  a roleplay reader never sees them. If OFF costs materially less and the prose
  is not worse, RP_REASONING=off is justified — and the prose comparison is a
  human judgement this script deliberately does not pretend to make.
`);
