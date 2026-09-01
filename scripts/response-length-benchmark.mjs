#!/usr/bin/env node
/**
 * Does Concise actually produce a concise reply?
 *
 * The report was specific: MiMo V2.5 on Concise still writes about six
 * paragraphs. That is a claim about what a model DOES, and no amount of reading
 * the prompt can settle it — so this sends the same representative turns to
 * two or more models at all three response lengths and prints paragraph counts,
 * word counts and completion tokens side by side.
 *
 * It reports what came back, including when the answer is unflattering. A run
 * where Concise and Natural produce the same length is the most useful run this
 * can produce, because it means the directive is not landing and the change
 * that was made did not work.
 *
 * Usage:
 *   OPENROUTER_API_KEY=… node scripts/response-length-benchmark.mjs
 *   … --models xiaomi/mimo-v2.5,z-ai/glm-4.7   the writer and one control
 *   … --samples 3                              repeats per cell, averaged
 *   … --scene intimacy                         which representative turn
 *   … --reasoning on|off|unset                 reasoning tokens share the
 *                                              output envelope with the prose,
 *                                              so this is a length variable
 *   … --json                                   machine-readable rows
 *
 * The prompts are synthetic and shaped like Afterglow's. Nothing here reads a
 * real conversation, writes to the database, or touches anybody's story.
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST: it costs money and needs network egress
 * to a paid endpoint, so it cannot run in CI. The parts that CAN be checked
 * offline — that the envelope is right, that the directive is present, that
 * nothing in the prompt contradicts it — are asserted in
 * tests/response-length.test.ts, which runs on every commit.
 */

import { responseLengthPlan, lengthAwareWriterRules } from "../src/lib/response-length.ts";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 || at === args.length - 1 ? fallback : args[at + 1];
};
const flag = (name) => args.includes(`--${name}`);

/**
 * What to send for `reasoning`, in the three states the app distinguishes.
 * `off` is the default here because it is what the chat route now sends for
 * every model whose catalogue entry declares it; `unset` reproduces the old
 * behaviour of taking the endpoint's own default.
 */
const reasoningSetting = option("reasoning", "off");
if (!["on", "off", "unset"].includes(reasoningSetting)) {
  console.error("--reasoning takes on, off or unset");
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("OPENROUTER_API_KEY is required. This script measures live model behaviour on purpose.");
  console.error("The offline half of the same question runs in tests/response-length.test.ts.");
  process.exit(1);
}

const baseUrl = (process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "");
const models = option("models", "xiaomi/mimo-v2.5,z-ai/glm-4.7").split(",").map((value) => value.trim()).filter(Boolean);
const samples = Math.max(1, Number(option("samples", 2)));
const sceneName = option("scene", "quiet");
const lengths = ["concise", "natural", "detailed"];

/**
 * Which models Afterglow declares as expansive writers.
 *
 * Mirrors `ModelCapabilities.verbosity`, keyed by the upstream slug this script
 * sends rather than by Afterglow's catalogue id, so a run reflects the request
 * the product would actually build for that model.
 */
const expansive = new Set(["xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5-pro"]);

/**
 * Representative turns.
 *
 * Three shapes, because response length is not one behaviour: a quiet exchange
 * is where Concise should be easy, an action beat is where a model most wants
 * to expand, and an intimate scene is where the base prompt's own "let the
 * moment develop" instinct pulls hardest against it.
 */
const scenes = {
  quiet: {
    setting: "Maya's apartment, late evening. They are on the couch with the television muted.",
    turn: "I set my glass down and look at her. \"You've been quiet all night. What is it?\"",
  },
  action: {
    setting: "A stairwell in a burning building. Smoke is coming up from below.",
    turn: "I grab her wrist and pull her toward the roof access. \"We're not going down. Move.\"",
  },
  intimacy: {
    setting: "Maya's bedroom, after midnight. The door is closed and neither of them has said anything for a minute.",
    turn: "I reach over and take her hand. \"Stay.\"",
  },
};
const scene = scenes[sceneName];
if (!scene) {
  console.error(`Unknown scene "${sceneName}". Choose one of: ${Object.keys(scenes).join(", ")}`);
  process.exit(1);
}

/**
 * A prompt shaped like Afterglow's, built from Afterglow's own decisions.
 *
 * The rules and the directive come from `src/lib/response-length.ts` rather
 * than being retyped here, so a run measures the product's actual instructions
 * and cannot drift away from them.
 */
function systemPrompt(length, verbosity) {
  const plan = responseLengthPlan(length, 1800, verbosity);
  const rules = [
    "Give every portrayed character independent motives, boundaries and agency.",
    "Advance the scene through action, dialogue, changing circumstances and consequences.",
    "Use the character's distinctive vocabulary, rhythm, worldview and body language.",
    "Never write the user's dialogue, decisions, internal thoughts, or consent for them.",
    "Do not merely restate, praise, or mirror the user's message. Respond to its implications.",
    ...lengthAwareWriterRules(length),
    "Write actions and narration as ordinary prose, and put spoken dialogue in quotation marks.",
    "Do not append menus, suggested replies, disclaimers, summaries, or out-of-character notes.",
  ].map((rule) => `- ${rule}`).join("\n");

  return `You are Maya and portray the living world around them in an ongoing private roleplay.

CHARACTER
Maya is thirty-one, a restoration architect, dry and observant, slow to say what she means and precise once she does. She has known the user for two years.

RULES
${rules}
${plan.instruction}`;
}

/** The last thing before the turn, exactly as `writerMessages` tail placement. */
function continuityBlock(length, verbosity) {
  const plan = responseLengthPlan(length, 1800, verbosity);
  return `CURRENT CONTINUITY — DYNAMIC FOR THIS REPLY
CURRENT SCENE — THIS IS NOW
Location: ${scene.setting}
Present: Maya, the user
Rolling state and story-so-far: They have been circling something unsaid for a week.${plan.reminder}`;
}

function paragraphsOf(text) {
  return text.trim().split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
}
function wordsOf(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
/** A reply that stops mid-sentence is a truncation, and that is a failure. */
function endsCleanly(text) {
  return /[.!?…"”'’)\]]$/.test(text.trim());
}

async function askOnce(model, length) {
  const verbosity = expansive.has(model) ? "expansive" : "normal";
  const plan = responseLengthPlan(length, 1800, verbosity);
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt(length, verbosity) },
      { role: "assistant", content: "Maya glances at the muted screen, then at nothing in particular." },
      { role: "system", content: continuityBlock(length, verbosity) },
      { role: "user", content: scene.turn },
    ],
    max_tokens: plan.maxTokens,
    temperature: 0.95,
    usage: { include: true },
    /*
     * REASONING IS PART OF THE LENGTH QUESTION, not a separate one.
     *
     * Reasoning tokens are spent from the SAME output envelope as the prose, so
     * a hybrid reasoning model that thinks before it speaks can consume most of
     * a Natural reply's 1,800 tokens and then be cut off mid-sentence at
     * `finish_reason: "length"` — which reads to a reader as "the writer stopped
     * for no reason" and to an operator as nothing at all.
     *
     * Omitting the parameter takes the endpoint's default, which on such a model
     * IS reasoning, so this defaults to declining it explicitly — the same thing
     * the chat route now sends for a model whose catalogue entry says so.
     * `--reasoning on` runs the other side of the comparison, which is what
     * turns "the envelope is too small" into a measurement rather than a guess.
     */
    ...(reasoningSetting === "unset" ? {} : { reasoning: { enabled: reasoningSetting === "on" } }),
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": "Afterglow response-length benchmark" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    console.error(`${model} / ${length}: HTTP ${response.status} ${(await response.text()).slice(0, 240)}`);
    return null;
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? "";
  const finish = data.choices?.[0]?.finish_reason ?? "";
  return {
    paragraphs: paragraphsOf(text).length,
    words: wordsOf(text),
    completionTokens: data.usage?.completion_tokens ?? 0,
    // The half of the envelope the reader never sees. A large number here beside
    // a truncated reply is the whole diagnosis.
    reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    budget: plan.maxTokens,
    truncated: finish === "length" || !endsCleanly(text),
    atCeiling: finish === "length",
    finish,
    text,
  };
}

const average = (values) => values.reduce((total, value) => total + value, 0) / Math.max(1, values.length);
const pad = (value, width) => String(value).padStart(width);

const rows = [];
console.log(`scene=${sceneName}  samples=${samples}  models=${models.join(", ")}\n`);
console.log(`reasoning=${reasoningSetting}\n`);
console.log("model                     length     paras   words   out-tok  reason  budget  at-ceiling  truncated");

for (const model of models) {
  for (const length of lengths) {
    const results = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const result = await askOnce(model, length);
      if (result) results.push(result);
    }
    if (!results.length) continue;
    const row = {
      model, length,
      paragraphs: Number(average(results.map((result) => result.paragraphs)).toFixed(1)),
      words: Math.round(average(results.map((result) => result.words))),
      completionTokens: Math.round(average(results.map((result) => result.completionTokens))),
      reasoningTokens: Math.round(average(results.map((result) => result.reasoningTokens))),
      budget: results[0].budget,
      atCeiling: results.filter((result) => result.atCeiling).length,
      truncated: results.filter((result) => result.truncated).length,
      samples: results.length,
    };
    rows.push(row);
    console.log([
      model.padEnd(26), length.padEnd(11),
      pad(row.paragraphs, 5), pad(row.words, 8), pad(row.completionTokens, 9),
      pad(row.reasoningTokens, 8), pad(row.budget, 8),
      pad(`${row.atCeiling}/${row.samples}`, 12), pad(`${row.truncated}/${row.samples}`, 11),
    ].join(""));
  }
}

if (flag("json")) console.log(`\n${JSON.stringify(rows, null, 2)}`);

// The two questions the run exists to answer, stated rather than left to the
// reader of a table.
for (const model of models) {
  const concise = rows.find((row) => row.model === model && row.length === "concise");
  const natural = rows.find((row) => row.model === model && row.length === "natural");
  const detailed = rows.find((row) => row.model === model && row.length === "detailed");
  if (!concise || !natural || !detailed) continue;
  console.log(`\n${model}`);
  console.log(`  concise is ${concise.paragraphs} paragraphs / ${concise.words} words — ${concise.paragraphs <= 2.4 ? "within the brief" : "STILL NOT CONCISE"}`);
  console.log(`  natural  ${natural.words} words, detailed ${detailed.words} words — ${detailed.words > natural.words ? "detailed is materially longer" : "DETAILED DID NOT GROW"}`);
  const truncations = concise.truncated + natural.truncated + detailed.truncated;
  console.log(`  ${truncations === 0 ? "no truncation in any cell" : `TRUNCATED in ${truncations} sample(s) — the envelope is too tight`}`);
}
