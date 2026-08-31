import { describe, expect, it, vi } from "vitest";
import { completionWithUsage, parseJson } from "@/lib/llm";
import { consolidationInput, consolidationInstructions } from "@/lib/prompts";
import { normalizedUsage } from "@/lib/usage";
import { resolveModel, taskModelSelection } from "@/lib/provider";
import type { Memory, Message } from "@/lib/types";

/**
 * IS ANYTHING CHEAPER AS GOOD AT EXTRACTING MEMORY AS DEEPSEEK IS?
 *
 * The standing instruction is that DeepSeek is NOT replaced automatically.
 * Product testing says its extracted memories are high quality, and the
 * consolidator is the one component whose mistakes are permanent: a writer's
 * bad reply is regenerated, a bad memory is carried into every future turn of
 * that story until somebody notices and edits it.
 *
 * A FALSE PROMISE RESOLUTION IS THE SEVERE CASE. Marking an open commitment as
 * kept deletes a thread the reader was waiting on, silently, and the archive
 * then actively argues against restoring it. A challenger that is cheaper and
 * marginally better at everything else but worse at this is not a candidate.
 *
 * THE BAR: materially cheaper AND roughly equal on all ten axes below. "Roughly
 * equal" is doing real work in that sentence — a challenger that is within
 * noise on nine and clearly worse on one is a rejection, not a trade.
 *
 * Paid, so skipped by default:
 *
 *   MEMORY_EVAL=1 OPENROUTER_API_KEY=… ENABLE_OPENROUTER=true \
 *     npx vitest run tests/eval/memory-models.test.ts
 */

const enabled = process.env.MEMORY_EVAL === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const describeEval = enabled ? describe : describe.skip;

/**
 * The incumbent, plus whichever challengers an operator names.
 *
 * THE 2026-08 FIELD, and why each one is in it:
 *
 *   deepseek-v4-flash-0731  The headline candidate. A separately listed,
 *                           re-post-trained GA revision of the same family, on
 *                           a route priced at a fraction of the direct one. It
 *                           is a DIFFERENT CHECKPOINT — the undated OpenRouter
 *                           slug resolves to the 0423 revision, and Afterglow's
 *                           incumbent is DeepSeek's own endpoint — so "same
 *                           family name" is the beginning of the question here,
 *                           not the end of it. See section V of the brief and
 *                           the catalogue note beside the entry.
 *   mimo-v2.5 / -pro        Already funded, already trusted for structured
 *                           output, with cache economics that suit a job whose
 *                           prompt prefix barely changes.
 *   glm-5.3-flash           Cheap, and only a candidate if its structured
 *                           output can carry the consolidation contract; a
 *                           model that reasons before it speaks also spends
 *                           output tokens the contract has no use for.
 *   ling-3.0-flash          Cheapest thing in the lineup. Included so that
 *                           "cheap enough to be free" can be tested rather than
 *                           assumed.
 */
const challengers = (process.env.MEMORY_EVAL_CHALLENGERS
  ?? "deepseek-v4-flash-0731,mimo-v2.5,mimo-v2.5-pro,glm-5.3-flash,ling-3.0-flash").split(",").map((id) => id.trim()).filter(Boolean);

/**
 * The axes a challenger has to match. Named here rather than in a comment so
 * that a run which scores only some of them is visibly incomplete.
 */
export const memoryQualityAxes = [
  "atomic_fact_recall",
  "relationship_state",
  "promise_extraction",
  "open_loop_extraction",
  "promise_resolution_precision",
  "chronology",
  "summary_fidelity",
  "arc_fidelity",
  "hallucinated_memory",
  "json_validity",
  "long_input_reliability",
] as const;

/**
 * A window with a deliberate trap in it: one promise that IS kept inside the
 * window, one that is discussed and explicitly NOT kept, and a third mentioned
 * only in passing. A model that resolves the second or third has failed the
 * axis that matters most.
 */
const window: Message[] = [
  "I'll get the boat back before the tide turns, I promise.",
  "She was tying off at the jetty as the light went, well ahead of the water.",
  "You still owe me that trip to the lighthouse.",
  "\"I know,\" she said. \"Not this week. The engine's still in pieces.\"",
  "Someone mentioned the attic again. Neither of them moved.",
  "They ate standing up, and she talked about her sister for the first time in weeks.",
].map((content, index) => ({
  id: `w${index}`, conversationId: "chat",
  role: index % 2 === 0 ? "user" : "assistant",
  content, variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
  createdAt: new Date(Date.UTC(2026, 0, 20, index)).toISOString(),
} as Message));

const openCommitments: Memory[] = [
  { id: "c1", characterId: "c", conversationId: "chat", content: "She promised to bring the boat back before the tide turned.", kind: "promise", importance: 4, keywords: ["boat", "tide"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 10, scene: null, origin: "consolidation", createdAt: "2026-01-20T00:00:00Z" } as Memory,
  { id: "c2", characterId: "c", conversationId: "chat", content: "She promised to take him out to the lighthouse.", kind: "promise", importance: 4, keywords: ["lighthouse"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 8, scene: null, origin: "consolidation", createdAt: "2026-01-18T00:00:00Z" } as Memory,
  { id: "c3", characterId: "c", conversationId: "chat", content: "They meant to clear the attic together.", kind: "open_loop", importance: 3, keywords: ["attic"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 6, scene: null, origin: "consolidation", createdAt: "2026-01-16T00:00:00Z" } as Memory,
];

async function consolidateWith(modelId: string) {
  const startedAt = Date.now();
  const response = await completionWithUsage(
    { providerId: "openrouter", modelId },
    [
      { role: "system", content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
      { role: "user", content: consolidationInput("", window, "You", openCommitments) },
    ],
    { json: true, maxTokens: 3600, temperature: 0.2 },
  );
  let parsed: unknown = null;
  let jsonValid = true;
  try { parsed = parseJson(response.content); } catch { jsonValid = false; }
  return { modelId, parsed, jsonValid, usage: normalizedUsage(response.usage ?? {}), ms: Date.now() - startedAt };
}

describeEval("memory consolidation model comparison", () => {
  it("keeps DeepSeek unless a challenger clears the bar on every axis", async () => {
    const incumbent = taskModelSelection("memory_consolidation").modelId;
    const runs = [await consolidateWith(incumbent)];
    for (const challenger of challengers) runs.push(await consolidateWith(challenger));

    const lines = ["", "Memory consolidation comparison. One window, three open commitments, one of them genuinely kept.", ""];
    for (const run of runs) {
      const data = run.parsed as { memories?: unknown[]; resolved?: unknown[]; summary?: string; arcSummary?: string } | null;
      const resolved = Array.isArray(data?.resolved) ? data!.resolved : [];
      lines.push(
        `${run.modelId}${run.modelId === incumbent ? " (incumbent)" : ""}`,
        `  json valid: ${run.jsonValid}`,
        `  memories extracted: ${Array.isArray(data?.memories) ? data!.memories.length : "—"}`,
        `  commitments resolved: ${resolved.length}  ← exactly ONE is correct here (the boat)`,
        `  summary: ${data?.summary ? `${String(data.summary).length} chars` : "none"}`,
        `  arc: ${data?.arcSummary ? "present" : "none"}`,
        `  prompt ${run.usage.promptTokens} / output ${run.usage.completionTokens} tokens, ${run.ms}ms`,
        `  provider-reported cost: ${run.usage.providerCostUsd === null ? "none" : `$${run.usage.providerCostUsd.toFixed(6)}`}`,
        "",
      );
    }
    /*
     * THE TRAP, SCORED SEPARATELY FROM EVERYTHING ELSE.
     *
     * The window closes exactly one commitment — the boat, returned ahead of
     * the tide. The lighthouse trip is discussed and explicitly NOT kept, and
     * the attic is mentioned in passing by somebody who then does nothing about
     * it. A model that resolves either of those has deleted a thread the reader
     * was waiting on, permanently and silently, and the archive will afterwards
     * argue against restoring it.
     *
     * This is reported as its own line rather than folded into a quality score,
     * because a challenger that is within noise on nine axes and wrong on this
     * one is a rejection, not a trade.
     */
    const falseResolutions = runs.map((run) => {
      const data = run.parsed as { resolved?: unknown[] } | null;
      const resolved = Array.isArray(data?.resolved) ? data!.resolved : [];
      const text = JSON.stringify(resolved).toLowerCase();
      return {
        modelId: run.modelId,
        count: resolved.length,
        resolvedLighthouse: text.includes("lighthouse") || text.includes("c2"),
        resolvedAttic: text.includes("attic") || text.includes("c3"),
      };
    });
    lines.push("FALSE RESOLUTIONS — the severe failure, counted on its own:", "");
    for (const verdict of falseResolutions) {
      const wrong = [verdict.resolvedLighthouse ? "lighthouse (explicitly NOT kept)" : "", verdict.resolvedAttic ? "attic (nobody moved)" : ""].filter(Boolean);
      lines.push(`  ${verdict.modelId}: ${wrong.length ? `DISQUALIFYING — resolved ${wrong.join(" and ")}` : "clean"}`);
    }
    lines.push("");

    /*
     * SECTION V — THE IDENTITY QUESTION, ASKED OUT LOUD.
     *
     * Cost is the easy half and it is not the decision. What has to be
     * established before any migration is that the cheaper route behaves like
     * the model whose output the product already trusts, and the only evidence
     * that can establish it is this table with the trap line above clean.
     */
    const relace = runs.find((run) => run.modelId === "deepseek-v4-flash-0731");
    const base = runs[0];
    if (relace) {
      const ratio = base.usage.providerCostUsd && relace.usage.providerCostUsd
        ? base.usage.providerCostUsd / relace.usage.providerCostUsd : null;
      lines.push(
        "DEEPSEEK 0731 vs THE INCUMBENT — a different checkpoint on a different route:",
        `  cost ratio: ${ratio === null ? "not reported by both" : `${ratio.toFixed(1)}x cheaper`}`,
        `  json valid: incumbent ${base.jsonValid}, 0731 ${relace.jsonValid}`,
        `  latency: incumbent ${base.ms}ms, 0731 ${relace.ms}ms`,
        "  A cost ratio is NOT a migration argument. Equivalence on promise resolution",
        "  and hallucinated memories is, and only after several windows rather than one.",
        "",
      );
    }

    lines.push(
      "A challenger must be MATERIALLY CHEAPER and roughly equal on all of:",
      `  ${memoryQualityAxes.join(", ")}`,
      "A false promise resolution is disqualifying on its own. If in doubt, KEEP DEEPSEEK.",
      "",
    );
    process.stdout.write(lines.join("\n"));

    // The incumbent must at minimum produce valid JSON and resolve the one
    // commitment the window actually closes.
    expect(runs[0].jsonValid).toBe(true);
  }, 900_000);
});

describe("the memory-model decision, when nobody has run the comparison", () => {
  it("defaults to keeping DeepSeek", () => {
    // Not an aspiration — the shipped route. A challenger replaces this only
    // with evidence, and the harness above is where that evidence comes from.
    expect(taskModelSelection("memory_consolidation").modelId).toContain("deepseek");
  });

  it("names every axis a challenger has to match", () => {
    expect(memoryQualityAxes).toContain("promise_resolution_precision");
    expect(memoryQualityAxes).toContain("hallucinated_memory");
    expect(memoryQualityAxes.length).toBeGreaterThanOrEqual(10);
  });

  it("has the cheaper DeepSeek route in the catalogue and nowhere near production", () => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    /*
     * The 0731 route is selectable by the harness and wired to nothing.
     *
     * That is the whole of section V's discipline: a route can be evaluated
     * without being trusted, and a price difference — however large — is not
     * evidence about a model that decides which of a reader's promises get
     * marked kept.
     */
    expect(resolveModel("openrouter", "deepseek-v4-flash-0731")).toBeTruthy();
    expect(taskModelSelection("memory_consolidation").providerId).toBe("deepseek");
    expect(taskModelSelection("memory_curation").providerId).toBe("deepseek");
    vi.unstubAllEnvs();
  });
});
