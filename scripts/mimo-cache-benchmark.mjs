#!/usr/bin/env node
/**
 * What a MiMo turn actually costs, measured against the live endpoint.
 *
 * MiMo is interesting because of its cached-input price — about one forty-sixth
 * of its fresh-input price — and that number is a property of OpenRouter's
 * price list, not of Afterglow. Whether the discount ARRIVES depends on whether
 * Afterglow's prompt has a stable prefix, whether the session stays on one
 * upstream host, and whether that host caches at all. None of that can be
 * argued from source, so this sends real sequential turns and reports what came
 * back.
 *
 * It reports the numbers even when they are bad. A run where `cached` stays at
 * zero is the most useful run this script can produce, because it means the
 * prefix is moving and the prompt layout is wrong — see the offline measurement
 * in tests/prompt-cost.test.ts, which says WHERE it moves.
 *
 * Usage:
 *   OPENROUTER_API_KEY=… node scripts/mimo-cache-benchmark.mjs
 *   … --model xiaomi/mimo-v2.5-pro --turns 8 --world large
 *   … --pin xiaomi          compare Xiaomi's own endpoint against the rest
 *   … --pin none            let OpenRouter route freely
 *
 * Nothing here writes to Afterglow's database or reads a real conversation. The
 * prompts are synthetic and shaped like Afterglow's, so a run costs a few cents
 * and cannot touch anybody's story.
 */

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required. This script talks to the live endpoint on purpose.");
  process.exit(1);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const model = option("model", "xiaomi/mimo-v2.5");
const turns = Number(option("turns", 6));
const worldSize = option("world", "small");
const pin = option("pin", "");
const sessionId = option("session", `afterglow-bench-${Date.now().toString(36)}`);

/** Prices per million tokens, from OpenRouter's catalogue on 2026-08-25. */
const prices = {
  "xiaomi/mimo-v2.5": { input: 0.119, cached: 0.00255, output: 0.238 },
  "xiaomi/mimo-v2.5-pro": { input: 0.3045, cached: 0.0028, output: 0.609 },
};

const lorem = (words) => Array.from({ length: words }, (_, index) => `lore${index % 97}`).join(" ");
const worldWords = { none: 0, small: 320, medium: 3_000, large: 16_500 }[worldSize] ?? 320;

/**
 * A prompt shaped like Afterglow's: a long stable head, then a short dynamic
 * tail. The point of the shape is that everything before the tail is what a
 * provider can reuse.
 */
function systemPrompt(turn) {
  const stable = [
    "You are Maya and portray the living world around them in an ongoing private roleplay.",
    `CHARACTER\nBackstory: ${lorem(240)}\nPersonality: ${lorem(140)}\nExample dialogue: ${lorem(120)}`,
    `LOREBOOK / WORLD CANON\n${worldWords ? lorem(worldWords) : "No reusable world documents are attached."}`,
    `ACTIVE USER PERSONA\nName: Ivy\nProfile: ${lorem(45)}`,
    `RULES\n${lorem(300)}`,
  ].join("\n\n");
  // The moving part. In Afterglow this is the continuity block, and where it
  // sits decides how much of the prompt above it stays reusable.
  const dynamic = `CURRENT CONTINUITY — DYNAMIC FOR THIS REPLY\nRolling state: ${lorem(120)} (turn ${turn})`;
  return `${stable}\n\n${dynamic}`;
}

function transcript(turn) {
  const messages = [];
  for (let index = 0; index < turn; index += 1) {
    messages.push({ role: "user", content: `${lorem(45)} — turn ${index}` });
    messages.push({ role: "assistant", content: lorem(180) });
  }
  messages.push({ role: "user", content: `${lorem(40)} — turn ${turn}` });
  return messages;
}

function providerBlock() {
  if (pin === "none") return undefined;
  if (pin) return { only: [pin], allow_fallbacks: false };
  // Production's own policy: prefer Xiaomi, never require it.
  return { order: ["xiaomi"], allow_fallbacks: true };
}

async function runTurn(turn) {
  const body = {
    model,
    messages: [{ role: "system", content: systemPrompt(turn) }, ...transcript(turn)],
    max_tokens: 400,
    temperature: 0.95,
    stream: true,
    usage: { include: true },
    session_id: sessionId,
    ...(providerBlock() ? { provider: providerBlock() } : {}),
  };

  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow benchmark" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`turn ${turn}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ttft;
  let usage = null;
  let provider;
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const data = JSON.parse(payload);
        if (typeof data.provider === "string") provider = data.provider;
        const delta = data.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) { ttft ??= Date.now() - startedAt; output += delta; }
        if (data.usage) usage = data.usage;
      } catch { /* a malformed chunk is not a measurement */ }
    }
  }

  const price = prices[model];
  const promptTokens = usage?.prompt_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrites = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const nominal = price ? (promptTokens * price.input + completion * price.output) / 1e6 : null;
  const effective = usage?.cost ?? (price
    ? (cached * price.cached + (promptTokens - cached) * price.input + completion * price.output) / 1e6
    : null);

  return {
    turn,
    promptTokens,
    cached,
    cacheWrites,
    ratio: promptTokens ? cached / promptTokens : 0,
    completion,
    nominal,
    effective,
    provider: provider ?? "—",
    ttft: ttft ?? 0,
    total: Date.now() - startedAt,
    chars: output.length,
  };
}

const usd = (value) => value === null || value === undefined ? "—" : `$${value.toFixed(6)}`;
const pad = (value, width) => String(value).padStart(width);

console.log(`model=${model}  world=${worldSize} (~${worldWords} words)  turns=${turns}  session=${sessionId}  routing=${pin || "prefer xiaomi"}\n`);
console.log("turn  prompt   cached  writes   ratio  output      nominal     effective  provider          ttft   total");

const rows = [];
for (let turn = 1; turn <= turns; turn += 1) {
  const row = await runTurn(turn);
  if (!row) continue;
  rows.push(row);
  console.log([
    pad(row.turn, 4), pad(row.promptTokens, 8), pad(row.cached, 8), pad(row.cacheWrites, 7),
    pad(`${(row.ratio * 100).toFixed(1)}%`, 7), pad(row.completion, 7),
    pad(usd(row.nominal), 12), pad(usd(row.effective), 13),
    ` ${(row.provider).padEnd(16)}`, pad(`${row.ttft}ms`, 7), pad(`${row.total}ms`, 7),
  ].join(""));
}

if (rows.length) {
  const sum = (key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const providers = [...new Set(rows.map((row) => row.provider))];
  console.log(`\n${rows.length} turns · ${sum("promptTokens").toLocaleString()} prompt tokens · ${sum("cached").toLocaleString()} cached (${((sum("cached") / Math.max(1, sum("promptTokens"))) * 100).toFixed(1)}%)`);
  console.log(`nominal ${usd(sum("nominal"))} · effective ${usd(sum("effective"))} · saved ${usd(sum("nominal") - sum("effective"))}`);
  console.log(`upstream providers seen: ${providers.join(", ")}${providers.length > 1 ? "  ← stickiness did NOT hold; a moved session cannot hit a warm cache" : ""}`);
  if (sum("cached") === 0) {
    console.log("\nNo cached tokens at all. Either this endpoint does not cache, or the prompt's");
    console.log("prefix is moving between turns. tests/prompt-cost.test.ts names which section moves.");
  }
}
