import { describe, expect, it } from "vitest";
import { hybridRankArcs, hybridRankMemories, packCoreCanon } from "@/lib/memory-v2";
import { roleplayPrompt } from "@/lib/prompts";
import { assessEvidence, promptRegions } from "@/lib/eval/evidence";
import { crossVerdict } from "@/lib/eval/taxonomy";
import { formatSummary, summarize, type EvaluatedTurn } from "@/lib/eval/report";
import { continuityCases, evalCharacter, type ContinuityCase } from "../fixtures/continuity-cases";

/**
 * The deterministic half of the V2.1a gate.
 *
 * Each case is pushed through the REAL retrieval ranking and the REAL prompt
 * builder, and then the evidence locator is asked a single question: did the
 * fact this turn needed actually reach the writer, and did anything that
 * should have stayed out get in?
 *
 * No inference, no API key, no network — the ranker and the prompt builder are
 * pure functions, so this runs on every push. What it cannot do is judge
 * prose; that is what the replay harness and the optional judge are for. What
 * it can do, and what matters most right now, is tell us whether the prompt
 * was even given a chance to be right.
 */

type CaseResult = {
  testCase: ContinuityCase;
  observed: "pass" | "known_failure";
  detail: string;
  turn: EvaluatedTurn;
};

function runCase(testCase: ContinuityCase): CaseResult {
  const semantic = new Map(Object.entries(testCase.semantic ?? {}));
  const arcSemantic = new Map(Object.entries(testCase.semantic ?? {}));

  const rankedMemories = hybridRankMemories(
    testCase.memories, testCase.query, semantic,
    testCase.limit ?? 8, testCase.episodicBudget ?? 4200,
  );
  const rankedArcs = hybridRankArcs(testCase.arcs ?? [], testCase.query, arcSemantic, 4, 1400);
  const canon = packCoreCanon(testCase.canon ?? []);

  const prompt = roleplayPrompt(
    evalCharacter,
    testCase.summary ?? "",
    rankedMemories.selected,
    rankedArcs.selected,
    { ownerName: "You", ownerProfile: "", roleplayPreset: "immersive" },
    { coreCanon: canon, sceneState: testCase.scene ?? null },
  );

  const regions = promptRegions(prompt, testCase.transcript ?? []);
  const evidence = assessEvidence(regions, testCase.required, testCase.forbidden ?? []);

  // Stage one only. Nothing here generates a reply, so the outcome is derived
  // from whether the prompt was assembled correctly rather than from prose:
  // a missing required fact or a live contaminant is a retrieval failure on
  // its own terms, whatever the writer would have done with it.
  const failed = evidence.verdict !== "present" || evidence.contaminants.length > 0;
  const observed: CaseResult["observed"] = failed ? "known_failure" : "pass";

  const reasons: string[] = [];
  if (evidence.missing.length) reasons.push(`missing: ${evidence.missing.map((claim) => claim.id).join(", ")}`);
  if (evidence.contaminants.length) reasons.push(`contaminated: ${evidence.contaminants.map((entry) => entry.claim.id).join(", ")}`);
  if (evidence.transcriptOnly.length) reasons.push(`transcript-only: ${evidence.transcriptOnly.map((claim) => claim.id).join(", ")}`);

  const turn: EvaluatedTurn = {
    id: testCase.name,
    label: testCase.intent,
    verdict: crossVerdict({
      evidence: evidence.verdict,
      // A fixture asserts the prompt, not the prose. `clean` here means the
      // writer was given everything it needed and nothing it should not have.
      outcome: failed ? "error" : "clean",
      fromRetrieval: evidence.fromRetrieval,
      contaminated: evidence.contaminants.length > 0,
    }),
    attributionRef: {
      recalledMemoryIds: rankedMemories.selected.map((memory) => memory.id),
      recalledArcIds: rankedArcs.selected.map((arc) => arc.id),
      canonEntryIds: canon.map((entry) => entry.id),
    },
    notes: reasons.join("; ") || undefined,
  };

  return { testCase, observed, detail: reasons.join("; ") || "all required evidence present", turn };
}

const results = continuityCases.map(runCase);

describe("continuity fixtures", () => {
  it.each(results.map((result) => [result.testCase.name, result] as const))("%s", (_name, result) => {
    // Recorded, not aspirational. The suite is green on today's behaviour and
    // goes red both when something regresses and when a known failure starts
    // passing — the second being exactly the signal a V2.1b fix should produce.
    expect(
      result.observed,
      result.observed === "known_failure"
        ? `KNOWN FAILURE (${result.detail}) — ${result.testCase.intent}`
        : `now passing (${result.detail}); update the recorded expectation`,
    ).toBe(result.testCase.expected);
  });

  it("reports the attribution split", () => {
    const summary = summarize(results.map((result) => result.turn));
    // Printed rather than asserted: this suite measures prompt assembly, so
    // its split is not the product-level answer. That comes from the replay
    // harness. This is here so a regression is visible in CI output.
    console.log(`\n${formatSummary(summary, "Deterministic continuity fixtures")}\n`);
    expect(summary.total).toBe(continuityCases.length);
  });

  it("keeps a fact that only the transcript carries out of the retrieval bucket", () => {
    // The latent case exists to prove the locator can tell the two apart. If
    // this ever reports `fromRetrieval`, every other attribution is suspect.
    const latent = results.find((result) => result.testCase.name.includes("only the transcript carries"));
    expect(latent).toBeTruthy();
    expect(latent!.turn.verdict.fromRetrieval).toBe(false);
    expect(latent!.detail).toContain("transcript-only");
  });
});
