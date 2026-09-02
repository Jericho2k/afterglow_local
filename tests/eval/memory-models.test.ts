import { describe, expect, it, vi } from "vitest";
import { completionWithUsage, parseJson } from "@/lib/llm";
import { consolidationInput, consolidationInstructions } from "@/lib/prompts";
import { normalizedUsage } from "@/lib/usage";
import { resolveModel } from "@/lib/provider";
import { availabilityForTask, backgroundCandidate, backgroundCandidates, candidatesForTask } from "@/lib/background-routing";
import { inferenceSessionId } from "@/lib/inference-session";
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
 * THE BAR: materially cheaper AND roughly equal on every axis below. "Roughly
 * equal" is doing real work in that sentence — a challenger that is within
 * noise on thirteen and clearly worse on one is a rejection, not a trade.
 *
 * THE FIELD IS THE ADMIN SELECTOR'S FIELD, not a list maintained separately
 * here. `backgroundCandidates` is what an administrator can actually switch
 * production to, so it is what has to be measured; a benchmark of models nobody
 * can select is a benchmark of nothing.
 *
 * Paid, so skipped by default:
 *
 *   MEMORY_EVAL=1 OPENROUTER_API_KEY=… ENABLE_OPENROUTER=true \
 *     npx vitest run tests/eval/memory-models.test.ts
 *
 * A host pin nobody has opted into (see BACKGROUND_ROUTE_VERIFIED_UPSTREAMS) is
 * REPORTED AND SKIPPED rather than attempted. Both pinned tags are verified —
 * `open-inference/fp8` and `relace/fp4` — so the gate is now consent rather than
 * spelling; either way a column of failures beside a column of results reads
 * like a quality finding when it is a configuration one.
 */

const enabled = process.env.MEMORY_EVAL === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const describeEval = enabled ? describe : describe.skip;

/**
 * The axes a challenger has to match. Named here rather than in a comment so
 * that a run which scores only some of them is visibly incomplete.
 */
export const memoryQualityAxes = [
  "rolling_summary_fidelity",
  "identity_extraction",
  "relationship_change",
  "important_events",
  "promise_extraction",
  "open_loop_extraction",
  "preferences",
  "boundaries",
  "chronology",
  "contradiction_handling",
  "supersession",
  "promise_resolution_precision",
  "hallucinated_memory",
  "lost_important_fact",
  "json_schema_reliability",
] as const;

/**
 * A window with deliberate traps in it.
 *
 * One promise IS kept inside the window. One is discussed and explicitly NOT
 * kept. One is mentioned in passing by somebody who then does nothing about it.
 * One earlier fact is CONTRADICTED and superseded by a later line. A model that
 * resolves the second or third has deleted a thread the reader was waiting on;
 * a model that keeps the superseded fact alive has left the archive arguing
 * with itself.
 */
const window: Message[] = [
  "I'll get the boat back before the tide turns, I promise.",
  "She was tying off at the jetty as the light went, well ahead of the water.",
  "You still owe me that trip to the lighthouse.",
  "\"I know,\" she said. \"Not this week. The engine's still in pieces.\"",
  "Someone mentioned the attic again. Neither of them moved.",
  "They ate standing up, and she talked about her sister for the first time in weeks.",
  "I thought you said your sister lived in Aberdeen.",
  "\"She did. She moved down to Hull in the spring — I keep forgetting I never told you.\"",
  "And you still won't go back to the boatyard after dark. I've noticed.",
  "\"No. I won't. Don't ask me again.\"",
].map((content, index) => ({
  id: `w${index}`, conversationId: "chat",
  role: index % 2 === 0 ? "user" : "assistant",
  content, variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
  createdAt: new Date(Date.UTC(2026, 0, 20, index)).toISOString(),
} as Message));

const existingSummary = [
  "CURRENT STATE: evening at the jetty. She has just brought the boat in.",
  "MAJOR TIMELINE: They met at the boatyard in the autumn. She inherited the boat from her father.",
  "Her sister lives in Aberdeen. She has twice refused to talk about the accident.",
].join(" ");

const openCommitments: Memory[] = [
  { id: "c1", characterId: "c", conversationId: "chat", content: "She promised to bring the boat back before the tide turned.", kind: "promise", importance: 4, keywords: ["boat", "tide"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 10, scene: null, createdAt: "2026-01-20T00:00:00Z" } as Memory,
  { id: "c2", characterId: "c", conversationId: "chat", content: "She promised to take him out to the lighthouse.", kind: "promise", importance: 4, keywords: ["lighthouse"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 8, scene: null, createdAt: "2026-01-18T00:00:00Z" } as Memory,
  { id: "c3", characterId: "c", conversationId: "chat", content: "They meant to clear the attic together.", kind: "open_loop", importance: 3, keywords: ["attic"], pinned: false, status: "active", resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 6, scene: null, createdAt: "2026-01-16T00:00:00Z" } as Memory,
];

type Consolidation = {
  summary?: string;
  arcSummary?: string;
  memories?: Array<{ content?: string; kind?: string; importance?: number }>;
  memoryUpdates?: Array<{ id?: string; status?: string; resolution?: string }>;
};

type Run = {
  candidateId: string;
  label: string;
  modelId: string;
  providerId: string;
  parsed: Consolidation | null;
  jsonValid: boolean;
  usage: ReturnType<typeof normalizedUsage>;
  upstreamProvider: string | null;
  ms: number;
  error: string | null;
};

/** One consolidation, built exactly as `maybeConsolidate` builds it. */
async function consolidateWith(candidateId: string, repeat: number): Promise<Run> {
  const candidate = backgroundCandidate(candidateId)!;
  const selection = candidate.selection!;
  const startedAt = Date.now();
  try {
    const response = await completionWithUsage(selection, [
      { role: "system", content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
      { role: "user", content: consolidationInput(existingSummary, window, "You", openCommitments) },
    ], {
      json: true, maxTokens: 3600, temperature: 0.2,
      modelId: selection.modelId,
      /*
       * The same session id every repeat, because that is what production
       * sends and because it is half of what the cost column is measuring: a
       * second identical job through the same session is where a
       * provider-reported cached-token count should appear if it appears at
       * all.
       */
      sessionId: inferenceSessionId("memory_consolidation", `eval-${candidateId}`),
    });
    let parsed: Consolidation | null = null;
    let jsonValid = true;
    try { parsed = parseJson<Consolidation>(response.content); } catch { jsonValid = false; }
    return {
      candidateId, label: candidate.label, modelId: selection.modelId, providerId: selection.providerId,
      parsed, jsonValid, usage: normalizedUsage(response.usage ?? {}),
      upstreamProvider: response.usage?.upstream_provider ?? null,
      ms: Date.now() - startedAt, error: null,
    };
  } catch (error) {
    return {
      candidateId, label: candidate.label, modelId: selection.modelId, providerId: selection.providerId,
      parsed: null, jsonValid: false, usage: normalizedUsage({}), upstreamProvider: null,
      ms: Date.now() - startedAt,
      error: `${error instanceof Error ? error.message : String(error)}${repeat ? ` (repeat ${repeat})` : ""}`,
    };
  }
}

function resolvedIds(run: Run) {
  const updates = Array.isArray(run.parsed?.memoryUpdates) ? run.parsed!.memoryUpdates! : [];
  return updates.filter((update) => update.status === "resolved").map((update) => String(update.id ?? ""));
}

/** The severe failure, scored on its own rather than folded into an average. */
function trapVerdict(run: Run) {
  const ids = resolvedIds(run);
  const text = JSON.stringify(run.parsed?.memoryUpdates ?? []).toLowerCase();
  return {
    resolvedBoat: ids.includes("c1"),
    resolvedLighthouse: ids.includes("c2") || text.includes("lighthouse"),
    resolvedAttic: ids.includes("c3") || text.includes("attic"),
  };
}

/** Did the model notice Aberdeen was superseded by Hull? */
function supersessionVerdict(run: Run) {
  const memories = (run.parsed?.memories ?? []).map((memory) => String(memory.content ?? "").toLowerCase());
  const blob = `${memories.join(" ")} ${String(run.parsed?.summary ?? "").toLowerCase()}`;
  return {
    recordedHull: blob.includes("hull"),
    // The failure: the archive still asserting Aberdeen as current, with no
    // trace of the correction.
    stillAssertsAberdeen: blob.includes("aberdeen") && !blob.includes("hull"),
  };
}

/** Did the model keep the hard boundary the window states in plain words? */
function boundaryVerdict(run: Run) {
  const blob = JSON.stringify(run.parsed?.memories ?? []).toLowerCase();
  return { recordedBoundary: blob.includes("boatyard") && (blob.includes("boundary") || blob.includes("dark") || blob.includes("won't") || blob.includes("refus")) };
}

describeEval("memory consolidation model comparison", () => {
  it("keeps DeepSeek unless a challenger clears the bar on every axis", async () => {
    const repeats = Math.max(1, Number(process.env.MEMORY_EVAL_REPEATS) || 2);
    const availability = availabilityForTask("memory_consolidation");
    const runnable = availability.filter((entry) => entry.selectable && entry.candidate.selection);
    const blocked = availability.filter((entry) => !entry.selectable);

    const runs: Run[][] = [];
    for (const entry of runnable) {
      const attempts: Run[] = [];
      for (let repeat = 0; repeat < repeats; repeat += 1) attempts.push(await consolidateWith(entry.candidate.id, repeat));
      runs.push(attempts);
    }

    const lines = [
      "",
      "MEMORY CONSOLIDATION — one window with four traps in it, per candidate.",
      `${repeats} identical repeats each, so the second can show a cache hit if the endpoint offers one.`,
      "",
    ];

    for (const attempts of runs) {
      const first = attempts[0];
      const ok = attempts.filter((run) => !run.error);
      const totalCost = ok.reduce((sum, run) => sum + (run.usage.providerCostUsd ?? 0), 0);
      const reportedCost = ok.some((run) => run.usage.providerCostUsd !== null);
      const cached = ok.reduce((sum, run) => sum + run.usage.cacheHitTokens, 0);
      const prompt = ok.reduce((sum, run) => sum + run.usage.promptTokens, 0);
      lines.push(
        `${first.label}  [${first.candidateId}]`,
        `  route                 ${first.providerId}:${first.modelId}${first.upstreamProvider ? ` via ${first.upstreamProvider}` : ""}`,
        `  attempts              ${ok.length}/${attempts.length} succeeded`,
        `  json/schema valid     ${attempts.filter((run) => run.jsonValid).length}/${attempts.length}`,
        `  memories extracted    ${Array.isArray(first.parsed?.memories) ? first.parsed!.memories!.length : "—"}`,
        `  summary               ${first.parsed?.summary ? `${String(first.parsed.summary).length} chars` : "none"}`,
        `  arc                   ${first.parsed?.arcSummary ? "present" : "none"}`,
        "",
        "  COST",
        `    fresh input tokens  ${(prompt - cached).toLocaleString()}`,
        `    cached input tokens ${cached.toLocaleString()}`,
        `    output tokens       ${ok.reduce((sum, run) => sum + run.usage.completionTokens, 0).toLocaleString()}`,
        `    cache ratio         ${prompt ? `${((cached / prompt) * 100).toFixed(1)}%` : "—"}  (provider-reported; the only authority)`,
        `    provider cost       ${reportedCost ? `$${totalCost.toFixed(6)} over ${ok.length} updates` : "not reported by this endpoint"}`,
        `    cost / update       ${reportedCost && ok.length ? `$${(totalCost / ok.length).toFixed(6)}` : "—"}`,
        `    projected / 100     ${reportedCost && ok.length ? `$${((totalCost / ok.length) * 100).toFixed(4)}` : "—"}`,
        `    latency             ${ok.length ? `${Math.round(ok.reduce((sum, run) => sum + run.ms, 0) / ok.length)}ms mean` : "—"}`,
        `    failure rate        ${(((attempts.length - ok.length) / attempts.length) * 100).toFixed(0)}%`,
        "",
      );
      if (first.error) lines.push(`  ERROR: ${first.error}`, "");
    }

    lines.push("QUALITY — the axes where a wrong answer is permanent:", "");
    for (const attempts of runs) {
      const run = attempts[0];
      const trap = trapVerdict(run);
      const supersession = supersessionVerdict(run);
      const boundary = boundaryVerdict(run);
      const wrong = [
        trap.resolvedLighthouse ? "resolved the lighthouse (explicitly NOT kept)" : "",
        trap.resolvedAttic ? "resolved the attic (nobody moved)" : "",
        supersession.stillAssertsAberdeen ? "left Aberdeen standing after the correction to Hull" : "",
      ].filter(Boolean);
      lines.push(
        `  ${run.label}`,
        `    promise resolution   ${trap.resolvedBoat ? "closed the boat promise (correct)" : "MISSED the boat promise"}`,
        `    false resolutions    ${wrong.length ? `DISQUALIFYING — ${wrong.join("; ")}` : "clean"}`,
        `    supersession         ${supersession.recordedHull ? "recorded the move to Hull" : "did not record the correction"}`,
        `    boundary             ${boundary.recordedBoundary ? "kept the boatyard-after-dark refusal" : "lost the boundary"}`,
        "",
      );
    }

    if (blocked.length) {
      lines.push("NOT RUN:", "");
      for (const entry of blocked) lines.push(`  ${entry.candidate.label}: ${entry.reason}`);
      lines.push("");
    }

    lines.push(
      "A challenger must be MATERIALLY CHEAPER and roughly equal on all of:",
      `  ${memoryQualityAxes.join(", ")}`,
      "A false promise resolution is disqualifying on its own. If in doubt, KEEP DEEPSEEK.",
      "",
      "One window is a smoke test, not a verdict. Raise MEMORY_EVAL_REPEATS and add",
      "windows before moving production; a single sample cannot separate a model that",
      "is worse from a model that was unlucky.",
      "",
    );
    process.stdout.write(lines.join("\n"));

    // The incumbent must at minimum produce valid JSON.
    const incumbent = runs.find((attempts) => attempts[0].candidateId === "direct_deepseek");
    expect(incumbent?.[0].jsonValid).toBe(true);
  }, 1_800_000);
});

/**
 * What is true without a key, and therefore what CI asserts.
 *
 * Everything above needs paid inference. Everything below is about the shape of
 * the decision: which candidates exist, which are selectable, and what happens
 * by default when nobody has chosen.
 */
describe("the memory-model decision, when nobody has run the comparison", () => {
  it("defaults to keeping DeepSeek", () => {
    // Not an aspiration — the shipped route. A challenger replaces this only
    // with evidence, and the harness above is where that evidence comes from.
    const candidate = backgroundCandidate("direct_deepseek");
    expect(candidate?.selection).toEqual({ providerId: "deepseek", modelId: "deepseek-v4-flash" });
  });

  it("names every axis a challenger has to match", () => {
    expect(memoryQualityAxes).toContain("promise_resolution_precision");
    expect(memoryQualityAxes).toContain("hallucinated_memory");
    expect(memoryQualityAxes).toContain("lost_important_fact");
    expect(memoryQualityAxes).toContain("supersession");
    expect(memoryQualityAxes.length).toBeGreaterThanOrEqual(14);
  });

  it("offers exactly the field the brief asked for", () => {
    const ids = candidatesForTask("memory_consolidation").map((candidate) => candidate.id);
    for (const required of ["direct_deepseek", "deepseek_0731_openinference", "deepseek_0731_relace", "mimo_v25", "ling_3_flash"]) {
      expect(ids).toContain(required);
    }
    // "Disabled" is a Scene Ledger option and must never be a memory option: a
    // story that stops extracting memories stops having a past.
    expect(ids).not.toContain("off");
  });

  it("refuses a host pin nobody has opted into, and unlocks it by its exact tag", () => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "");
    /*
     * A pinned host is `provider.only` with fallbacks off, aimed at a third
     * party's catalogue and carrying readers' transcripts. The tags are now
     * verified — `open-inference/fp8` and `relace/fp4` — and the gate is
     * therefore no longer about spelling: it asks an operator to say they are
     * willing to send stories through that host.
     */
    const openinference = availabilityForTask("memory_consolidation").find((entry) => entry.candidate.id === "deepseek_0731_openinference");
    expect(openinference?.selectable).toBe(false);
    expect(openinference?.reason).toContain("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS");
    expect(openinference?.reason).toContain("background-route-verify");

    // The suffix is part of the route. Opting into the bare host name is not
    // opting into a precision nobody looked at.
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "open-inference");
    expect(availabilityForTask("memory_consolidation").find((entry) => entry.candidate.id === "deepseek_0731_openinference")?.selectable).toBe(false);

    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "open-inference/fp8");
    const confirmed = availabilityForTask("memory_consolidation").find((entry) => entry.candidate.id === "deepseek_0731_openinference");
    expect(confirmed?.selectable).toBe(true);
    // Opting into one host says nothing about the other.
    expect(availabilityForTask("memory_consolidation").find((entry) => entry.candidate.id === "deepseek_0731_relace")?.selectable).toBe(false);

    // The Railway line, exactly as it will be set.
    vi.stubEnv("BACKGROUND_ROUTE_VERIFIED_UPSTREAMS", "open-inference/fp8,relace/fp4");
    for (const id of ["deepseek_0731_openinference", "deepseek_0731_relace"]) {
      expect(availabilityForTask("memory_consolidation").find((entry) => entry.candidate.id === id)?.selectable, id).toBe(true);
    }
    vi.unstubAllEnvs();
  });

  it("keeps every candidate resolvable while OpenRouter is enabled", () => {
    vi.stubEnv("ENABLE_OPENROUTER", "true");
    vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
    for (const candidate of backgroundCandidates) {
      if (!candidate.selection) continue;
      expect(resolveModel(candidate.selection.providerId, candidate.selection.modelId), `${candidate.id} is not in the catalogue`).toBeTruthy();
    }
    vi.unstubAllEnvs();
  });
});
