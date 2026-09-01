import { describe, expect, it } from "vitest";
import { completionWithUsage } from "@/lib/llm";
import { normalizedUsage, estimateUsageCostRange } from "@/lib/usage";
import { roleplayPrompt, falseHistoryRule } from "@/lib/prompts";
import { judgeEnabled, judgeTurn } from "@/lib/eval/judge";
import { inferenceSessionId } from "@/lib/inference-session";
import { archive } from "../fixtures/retrieval-budget";
import { evalCharacter } from "../fixtures/continuity-cases";
import type { Message } from "@/lib/types";

/**
 * WRITER HALLUCINATION, MEASURED ON IDENTICAL CONTEXT.
 *
 * The question is not "which model writes best" — it is "which model invents a
 * shared past that never happened", which is the single most damaging failure
 * a roleplay writer has. A reader forgives a dull reply. A reader does not
 * forgive being told about a night they never had.
 *
 * THIS COSTS MONEY AND IS SKIPPED BY DEFAULT. Every model below is a paid call
 * and there are four of them plus an A/B arm, so nothing here runs in CI. Run
 * it deliberately:
 *
 *   WRITER_EVAL=1 OPENROUTER_API_KEY=… ENABLE_OPENROUTER=true \
 *     npx vitest run tests/eval/writer-models.test.ts
 *
 * Add EVAL_JUDGE=true to score the generations rather than only collecting
 * them; without a judge this reports tokens, latency, cache behaviour and the
 * upstream provider, which are the questions H1 asks and which need no judge.
 *
 * WHAT IS DELIBERATELY HELD IDENTICAL across every arm: the creation
 * definition, the literal transcript, the atomic memories, the arcs, the Core
 * Canon, the Scene State and the persona. The only thing that varies between
 * arms is the model — or, in the A/B, one rule. Anything else and the
 * comparison is measuring the harness.
 */

const enabled = process.env.WRITER_EVAL === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const describeEval = enabled ? describe : describe.skip;

/**
 * The field.
 *
 * MiMo and GLM are the candidates, DeepSeek V4 Flash is the incumbent, and Kimi
 * is the control — a model nobody is proposing to switch to, present so that a
 * result showing "every model does this" can be told apart from one showing
 * "this model does this".
 */
const writers = [
  { id: "mimo-v2.5", label: "MiMo V2.5" },
  { id: "glm-4.7", label: "GLM 4.7 (the writer being replaced)" },
  /*
   * THE 2026-08 CANDIDATES.
   *
   * GLM 5.3 Flash appears ONCE, as the one serving profile the product ships.
   * It used to appear twice, as "Fast" and "Economy" — the same weights and the
   * same slug on different endpoints — and any quality gap between two such
   * arms is a finding about SERVING — quantisation, truncation, a different
   * sampler — rather than about the model, which is precisely why the catalogue stopped
   * shipping two profiles of it: an unmeasured serving difference reaching
   * readers as a choice between two names is the failure this field measures.
   *
   * Ling is here on price alone and Qwen3.8 Flash on curiosity: the community
   * research pass found no roleplay signal for either, and strong benchmarks in
   * coding and agentic work say nothing about holding a character for ninety
   * turns. Neither is promoted on anything this file has not measured.
   */
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "ling-3.0-flash", label: "Ling 3.0 Flash (ultra-cheap candidate)" },
  { id: "qwen3.8-flash", label: "Qwen3.8 Flash (experimental)" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (incumbent)" },
  { id: "kimi-k2.6", label: "Kimi K2.6 (control)" },
] as const;

/**
 * THE QUESTION THIS FIELD IS ARRANGED TO ANSWER.
 *
 * Not "which model writes best" in the abstract — "does GLM 5.3 Flash keep
 * enough of what makes GLM 4.7 good to replace it for most readers". So GLM 4.7
 * is present as the incumbent to beat rather than as another candidate, Kimi is
 * the control that separates "every model does this" from "this model does
 * this", and GLM 5.3 Flash appears as the single route production actually
 * sends, so a result about it is a result about what readers get.
 *
 * The report at the end deliberately does NOT collapse into one score. A model
 * that is better at prose and worse at continuity is not "roughly equal", and
 * an average would say it was.
 */

/**
 * Turns chosen to bait a false history.
 *
 * Each one invites the writer to refer back to something the transcript and
 * the archive do NOT establish. A model that invents here is doing the thing
 * the rule exists to stop; a model that goes passive here is failing the other
 * way, which is why forward motion is scored separately.
 */
const turns = [
  { id: "shared-past-bait", user: "Do you remember the first time we met?" },
  { id: "agreement-bait", user: "You said you'd handle it — are we still good?" },
  { id: "milestone-bait", user: "It's been a year, hasn't it?" },
  { id: "plan-as-done-bait", user: "So how was the lighthouse?" },
  { id: "open-scene", user: "You're quiet tonight." },
] as const;

/** The same story context for every arm, built once. */
function context() {
  const memories = archive.filter((memory) => memory.status !== "superseded").slice(0, 8);
  const transcript: Message[] = [
    { id: "t1", conversationId: "chat", role: "user", content: "I brought the coffee up.", variants: [], selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: "2026-01-20T10:00:00Z" },
    { id: "t2", conversationId: "chat", role: "assistant", content: "She takes it without looking up from the chart she has been redrawing for an hour.", variants: [], selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: "2026-01-20T10:01:00Z" },
  ];
  return { memories, transcript };
}

function promptFor(withRule: boolean) {
  const { memories } = context();
  const prompt = roleplayPrompt(evalCharacter, "", memories, [], {
    ownerName: "You", roleplayPreset: "immersive", responseLength: "natural",
  } as Parameters<typeof roleplayPrompt>[4], {});
  // The A/B differs by exactly one line — the constant the product ships.
  return withRule ? prompt : prompt.replace(falseHistoryRule, "");
}

type Arm = { writer: string; rule: boolean; turn: string; text: string; usage: ReturnType<typeof normalizedUsage>; ms: number; upstream?: string; thinking?: boolean | "off" };

async function generate(writerId: string, withRule: boolean, turn: (typeof turns)[number], thinking?: boolean | "off"): Promise<Arm> {
  const { transcript } = context();
  const startedAt = Date.now();
  const response = await completionWithUsage(
    { providerId: "openrouter", modelId: writerId },
    [
      { role: "system", content: promptFor(withRule) },
      ...transcript.map((message) => ({ role: message.role, content: message.content })),
      { role: "user", content: turn.user },
    ],
    // A stable session id per arm, so a provider that supports sticky routing
    // gets the chance to demonstrate it. H1 is partly a question about that.
    {
      temperature: 0.9, maxTokens: 700, modelId: writerId,
      ...(thinking === undefined ? {} : { thinking }),
      // A stable session per ARM, including the reasoning setting: two arms
      // sharing a session would each be measuring the other's stickiness.
      sessionId: inferenceSessionId("rp_generation", `writer-eval:${writerId}:${withRule}:${thinking ?? "default"}`),
    },
  );
  return {
    writer: writerId, rule: withRule, turn: turn.id, thinking,
    text: response.content,
    usage: normalizedUsage(response.usage ?? {}),
    ms: Date.now() - startedAt,
    upstream: response.usage?.upstream_provider,
  };
}

describeEval("writer hallucination across models", () => {
  const results: Arm[] = [];

  it("generates every arm on identical story context", async () => {
    for (const writer of writers) {
      for (const turn of turns) {
        results.push(await generate(writer.id, true, turn));
      }
    }
    expect(results).toHaveLength(writers.length * turns.length);
    for (const arm of results) expect(arm.text.trim().length).toBeGreaterThan(0);
  }, 600_000);

  /*
   * H2 — the false-history rule, A/B.
   *
   * Scored on BOTH axes on purpose. A rule that reduces invented history by
   * making the writer passive is not a win, and an A/B that only counted false
   * claims would report it as one.
   */
  it("runs the false-history rule A/B on the incumbent", async () => {
    const withRule: Arm[] = [];
    const withoutRule: Arm[] = [];
    for (const turn of turns) {
      withRule.push(await generate("deepseek-v4-flash", true, turn));
      withoutRule.push(await generate("deepseek-v4-flash", false, turn));
    }
    expect(withRule).toHaveLength(turns.length);
    expect(withoutRule).toHaveLength(turns.length);
    results.push(...withRule, ...withoutRule);
  }, 600_000);

  it("scores the generations when a judge is available", async () => {
    if (!judgeEnabled()) {
      // Stated rather than silently passed: a benchmark that reports nothing
      // must not look like a benchmark that reported a pass.
      process.stdout.write("\n[writer-eval] EVAL_JUDGE is not set — hallucination rates were NOT scored. Token, latency, cache and provider figures below are still real.\n");
      return;
    }
    const facts = context().memories.map((memory) => memory.content);
    for (const arm of results) {
      const verdict = await judgeTurn({
        characterName: evalCharacter.name,
        facts,
        recentTranscript: context().transcript.map((message) => `${message.role}: ${message.content}`),
        userTurn: turns.find((turn) => turn.id === arm.turn)!.user,
        reply: arm.text,
      });
      expect(verdict).toBeTruthy();
    }
  }, 900_000);

  /*
   * SECTION E — REASONING ON VERSUS OFF, ON THE MODELS THAT CAN SWITCH IT.
   *
   * The catalogue already defaults GLM 5.3 Flash and Qwen3.8 Flash to no
   * reasoning, on one piece of external evidence: independent benchmarking put
   * GLM 5.3 Flash's median time to first token on a reasoning-heavy suite in
   * the tens of seconds, because the model thinks before it speaks. That is a
   * measurement of a CODING suite, and this is the arm that tells us whether it
   * transfers — and, more importantly, whether reasoning buys any roleplay
   * quality at all to trade against the wait.
   *
   * THREE STATES, NOT TWO. `undefined` takes the endpoint default, which on a
   * hybrid reasoning model is not the same as declining — that distinction has
   * already cost this codebase one bug, and an A/B that conflated them would be
   * comparing "on" against "on".
   */
  it("runs reasoning on, off, and unstated for the switchable models", async () => {
    const switchable = ["glm-5.3-flash", "qwen3.8-flash"] as const;
    const arms: Arm[] = [];
    for (const writer of switchable) {
      for (const turn of turns.slice(0, 3)) {
        for (const thinking of [true, "off", undefined] as const) {
          arms.push(await generate(writer, true, turn, thinking));
        }
      }
    }
    results.push(...arms);

    const lines = ["", "Reasoning A/B — same context, same turns, one parameter.", ""];
    for (const writer of switchable) {
      for (const thinking of [true, "off", undefined] as const) {
        const set = arms.filter((arm) => arm.writer === writer && arm.thinking === thinking);
        if (!set.length) continue;
        const reasoningTokens = set.reduce((sum, arm) => sum + arm.usage.reasoningTokens, 0);
        const output = set.reduce((sum, arm) => sum + arm.usage.completionTokens, 0);
        const cost = set.reduce((sum, arm) => sum + (arm.usage.providerCostUsd ?? 0), 0);
        lines.push(
          `${writer}  reasoning=${String(thinking)}`,
          `  avg latency ${Math.round(set.reduce((sum, arm) => sum + arm.ms, 0) / set.length)}ms`,
          `  output ${output}  of which reasoning ${reasoningTokens} (${((reasoningTokens / Math.max(1, output)) * 100).toFixed(1)}%)`,
          `  cost $${cost.toFixed(6)} over ${set.length} generations`,
          `  avg reply length ${Math.round(set.reduce((sum, arm) => sum + arm.text.length, 0) / set.length)} characters`,
          "",
        );
      }
    }
    /*
     * WHAT TO DO WITH THE ANSWER, stated here so a reader of the output does
     * not have to reconstruct the decision rule from the numbers: if reasoning
     * costs latency and tokens without a judge-visible quality gain, the
     * catalogue's `reasoningDefault: "off"` is confirmed and should stay. If it
     * buys real quality, the default is wrong and this is the evidence to
     * change it with.
     */
    lines.push("Decision rule: keep reasoningDefault:\"off\" unless the judge shows a real quality gain.", "");
    process.stdout.write(lines.join("\n"));
    expect(arms.length).toBeGreaterThan(0);
  }, 900_000);

  /*
   * H1 — GLM's cache and provider economics.
   *
   * Model-level caching does NOT follow a model across upstream providers, so
   * a theoretical cached-input rate is worth nothing if routing drifts between
   * hosts within one conversation. That is a measurement, and this is it.
   */
  it("reports cache behaviour and upstream provider per model", () => {
    const lines = ["", "Writer benchmark — identical story context, one variable per arm.", ""];
    for (const writer of writers) {
      const arms = results.filter((arm) => arm.writer === writer.id && arm.rule);
      if (!arms.length) continue;
      const prompt = arms.reduce((sum, arm) => sum + arm.usage.promptTokens, 0);
      const cached = arms.reduce((sum, arm) => sum + arm.usage.cacheHitTokens, 0);
      const output = arms.reduce((sum, arm) => sum + arm.usage.completionTokens, 0);
      const reported = arms.reduce((sum, arm) => sum + (arm.usage.providerCostUsd ?? 0), 0);
      const upstreams = [...new Set(arms.map((arm) => arm.upstream).filter(Boolean))];
      const estimate = estimateUsageCostRange(writer.id, { prompt_tokens: prompt, completion_tokens: output, prompt_cache_hit_tokens: cached });
      lines.push(
        `${writer.label}`,
        `  prompt ${prompt}  cached ${cached} (${((cached / Math.max(1, prompt)) * 100).toFixed(1)}%)  output ${output}`,
        `  avg latency ${Math.round(arms.reduce((sum, arm) => sum + arm.ms, 0) / arms.length)}ms`,
        `  upstream providers seen: ${upstreams.length ? upstreams.join(", ") : "not reported"}${upstreams.length > 1 ? "  ← ROUTING DRIFTED; model-level cache economics do not survive this" : ""}`,
        `  provider-reported cost $${reported.toFixed(6)}${reported ? "" : " (none reported)"}`,
        `  our estimate ${estimate ? `$${estimate.low.toFixed(6)}–$${estimate.high.toFixed(6)}` : "no rate known"}`,
        `  cost / 100 generations: $${((reported / Math.max(1, arms.length)) * 100).toFixed(4)}`,
        "",
      );
    }
    process.stdout.write(lines.join("\n"));
    expect(results.length).toBeGreaterThan(0);
  });
});

/**
 * The one thing that must be true whether or not anybody has keys: the rule the
 * A/B strips has to be the rule the product ships, or the experiment is about
 * a prompt nobody uses.
 */
describe("the false-history A/B is an A/B of the shipped rule", () => {
  it("strips exactly the constant the writer prompt is built from", () => {
    const withRule = promptFor(true);
    const without = promptFor(false);
    expect(withRule).toContain(falseHistoryRule);
    expect(without).not.toContain(falseHistoryRule);
    // And nothing else moved.
    expect(withRule.replace(falseHistoryRule, "")).toBe(without);
  });

  it("says plainly when it did not run", () => {
    if (!enabled) {
      expect(process.env.WRITER_EVAL === "1" && Boolean(process.env.OPENROUTER_API_KEY)).toBe(false);
    }
  });
});
