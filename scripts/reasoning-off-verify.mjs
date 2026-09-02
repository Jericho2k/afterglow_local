#!/usr/bin/env node
/**
 * DOES THIS ENDPOINT ACTUALLY HONOUR `reasoning: { enabled: false }`?
 *
 * Ling 3.0 Flash spent every Scene Ledger envelope on hidden thinking and never
 * reached the JSON:
 *
 *   upstream Novita · max_tokens 400 · finish_reason "length"
 *   content null · completion_tokens ~400 · reasoning_tokens ~400+
 *   hasReasoning true · requestedReasoningOff FALSE
 *
 * The catalogue said `thinking: false`, so nothing ever asked it not to. It says
 * `true` now and background extraction sends OpenRouter's normalised
 * `reasoning: { enabled: false }` — the same mechanism Afterglow already uses
 * everywhere else rather than any host's native spelling.
 *
 * WHAT THIS SCRIPT SETTLES, AND WHY IT CANNOT BE SETTLED BY READING. "OpenRouter
 * accepts the parameter" and "the upstream host obeys it" are different claims,
 * and Ling is served by several hosts (Novita and DeepInfra among them) with
 * their own serving profiles. A host that accepts the field and reasons anyway
 * is indistinguishable from one that honours it — until you look at
 * `reasoning_tokens`.
 *
 * So it sends one tiny request per host, twice: once asking for no reasoning and
 * once saying nothing, and prints the token split. If reasoning-off works, the
 * first has zero reasoning tokens and the second does not.
 *
 * USAGE
 *   OPENROUTER_API_KEY=… node scripts/reasoning-off-verify.mjs
 *   … --model ling-3.0-flash          catalogue id (default)
 *   … --providers novita,deepinfra    hosts to test individually
 *   … --json
 *
 * IT COSTS REAL MONEY, and about a hundredth of a cent: the prompt is one short
 * sentence and `max_tokens` is 200. Nothing here is run by CI.
 *
 * NOTHING IT PRINTS CAN CONTAIN A PROMPT OR A MODEL'S OUTPUT. The prompt is a
 * fixed, meaningless sentence written into this file, and only counts, flags and
 * finish reasons are reported — never `content` and never `reasoning`. That is
 * the same rule the adapter's own empty-response diagnostics follow, and it
 * matters here for the same reason: a reasoning trace is derived from whatever
 * was asked, and this script must stay safe to run against a production key.
 */

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : (args[at + 1] ?? true);
}
const asJson = args.includes("--json");

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error("OPENROUTER_API_KEY is required. This script sends real (tiny) requests and cannot guess it.");
  process.exit(2);
}
const base = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");

/**
 * The catalogue ids this understands, and the upstream slug each one sends.
 *
 * Deliberately a small table rather than an import: this is an operations
 * script, it runs against a deployment's key from a laptop, and importing the
 * TypeScript catalogue would drag a build step into a diagnostic.
 */
const models = {
  "ling-3.0-flash": "inclusionai/ling-3.0-flash",
  "ling-3.0-flash-free": "inclusionai/ling-3.0-flash:free",
  "deepseek-v4-flash-0731": "deepseek/deepseek-v4-flash-0731",
  "mimo-v2.5": "xiaomi/mimo-v2.5",
};

const modelId = String(flag("model", "ling-3.0-flash"));
const upstream = models[modelId] ?? modelId;
const providers = String(flag("providers", "")).split(",").map((value) => value.trim()).filter(Boolean);

/**
 * A prompt that is short, fixed, and about nothing.
 *
 * It asks for a tiny JSON object because that is the shape of the job being
 * diagnosed — a reasoning model given a trivial structured task is exactly the
 * case where thinking swallows the envelope.
 */
const prompt = [
  { role: "system", content: "You are a JSON emitter. Output JSON only." },
  { role: "user", content: 'Return {"ok":true} and nothing else.' },
];

async function probe(label, provider, reasoning) {
  const body = {
    model: upstream,
    messages: prompt,
    max_tokens: 200,
    temperature: 0,
    usage: { include: true },
    ...(reasoning ? { reasoning } : {}),
    ...(provider ? { provider: { only: [provider], allow_fallbacks: false } } : {}),
  };
  const started = Date.now();
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return { label, provider: provider ?? "(any)", error: `${response.status} ${(await response.text()).slice(0, 160)}`, ms: Date.now() - started };
  }
  const data = await response.json();
  const choice = data?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const usage = data?.usage ?? {};
  return {
    label,
    provider: provider ?? "(any)",
    servedBy: data?.provider ?? null,
    finishReason: choice.finish_reason ?? null,
    nativeFinishReason: choice.native_finish_reason ?? null,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    // Presence only. Never the text — see the header.
    hasReasoning: typeof message.reasoning === "string" && message.reasoning.length > 0,
    hasContent: typeof message.content === "string" && message.content.trim().length > 0,
    ms: Date.now() - started,
    error: null,
  };
}

const results = [];
for (const provider of providers.length ? providers : [null]) {
  results.push(await probe("reasoning OFF", provider, { enabled: false }));
  results.push(await probe("no reasoning key", provider, null));
}

if (asJson) {
  console.log(JSON.stringify({ model: modelId, upstream, results }, null, 2));
  process.exit(0);
}

console.log(`\n${modelId}  →  ${upstream}\n`);
const width = Math.max(18, ...results.map((row) => row.label.length));
console.log(`${"request".padEnd(width)}  ${"host".padEnd(14)}  ${"finish".padEnd(10)}  ${"out".padStart(5)}  ${"reason".padStart(6)}  content`);
for (const row of results) {
  if (row.error) {
    console.log(`${row.label.padEnd(width)}  ${String(row.provider).padEnd(14)}  ERROR ${row.error}`);
    continue;
  }
  console.log([
    row.label.padEnd(width),
    String(row.servedBy ?? row.provider).padEnd(14),
    String(row.finishReason ?? "—").padEnd(10),
    String(row.completionTokens ?? "—").padStart(5),
    String(row.reasoningTokens).padStart(6),
    row.hasContent ? "yes" : "NONE",
  ].join("  "));
}

console.log("\nHow to read it:\n");
console.log("  reasoning OFF with 0 reasoning tokens and content present");
console.log("      → the host honours reasoning-off. This is the fix working.");
console.log("  reasoning OFF with reasoning tokens > 0");
console.log("      → the host ACCEPTED the parameter and reasoned anyway. The catalogue");
console.log("        entry is right and the route is unsuitable for tiny structured jobs;");
console.log("        say so rather than raising max_tokens to hide it.");
console.log("  reasoning OFF returning a 400 about reasoning");
console.log("      → the endpoint mandates reasoning. Declare `reasoningMandatory: true`");
console.log("        on the model, which makes background extraction treat the route as");
console.log("        incompatible instead of silently taking the endpoint default.");
console.log("  no reasoning key with reasoning tokens > 0");
console.log("      → confirms the default is ON, which is why omitting the parameter was");
console.log("        never the same as declining it.\n");
