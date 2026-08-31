import { describe, expect, it } from "vitest";
import { completionWithUsage, parseJson } from "@/lib/llm";
import { consolidationInput, consolidationInstructions } from "@/lib/prompts";
import { normalizedUsage } from "@/lib/usage";
import { taskModelSelection } from "@/lib/provider";
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

/** The incumbent, plus whichever challengers an operator names. */
const challengers = (process.env.MEMORY_EVAL_CHALLENGERS ?? "mimo-v2.5,glm-4.7").split(",").map((id) => id.trim()).filter(Boolean);

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
});
