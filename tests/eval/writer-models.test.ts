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
  { id: "glm-4.7", label: "GLM 4.7" },
  { id: "deepseek-v4-flash", label: "DeepSeek V4 Flash (incumbent)" },
  { id: "kimi-k2.6", label: "Kimi K2.6 (control)" },
] as const;

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

type Arm = { writer: string; rule: boolean; turn: string; text: string; usage: ReturnType<typeof normalizedUsage>; ms: number; upstream?: string };

async function generate(writerId: string, withRule: boolean, turn: (typeof turns)[number]): Promise<Arm> {
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
    { temperature: 0.9, maxTokens: 700, sessionId: inferenceSessionId("rp_generation", `writer-eval:${writerId}:${withRule}`) },
  );
  return {
    writer: writerId, rule: withRule, turn: turn.id,
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
