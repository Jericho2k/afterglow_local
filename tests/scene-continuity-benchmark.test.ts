import { describe, expect, it } from "vitest";
import { roleplayPrompt } from "@/lib/prompts";
import { estimateTokens } from "@/lib/context";
import { benchmarkCharacter, continuityBenchmark } from "./fixtures/scene-continuity";

/**
 * Scene State off against Scene State on.
 *
 * For each situation the benchmark builds the writer prompt twice: once as the
 * product behaves today, and once with the scene ledger and its historical
 * annotations. The assertion is that the grounding a writer needs in order to
 * tell NOW from THEN is present in one and genuinely absent in the other, and
 * that it costs a small, bounded number of tokens to say so.
 */

/** Scene State off means no ledger and no stamps were ever written. */
function promptWithout(testCase: typeof continuityBenchmark[number]) {
  return roleplayPrompt(
    testCase.character ?? benchmarkCharacter, "",
    testCase.memories.map((memory) => ({ ...memory, scene: null })),
    (testCase.arcs ?? []).map((arc) => ({ ...arc, storyDayStart: null, storyDayEnd: null, locations: [] })),
  );
}

function promptWith(testCase: typeof continuityBenchmark[number]) {
  return roleplayPrompt(
    testCase.character ?? benchmarkCharacter, "",
    testCase.memories, testCase.arcs ?? [], undefined, { sceneState: testCase.sceneState },
  );
}

describe("continuity benchmark", () => {
  it.each(continuityBenchmark.map((testCase) => [testCase.name, testCase] as const))("%s", (_name, testCase) => {
    const off = promptWithout(testCase);
    const on = promptWith(testCase);
    for (const grounding of testCase.grounded) {
      expect(on, `"${grounding}" must reach the writer`).toContain(grounding);
      expect(off, `"${grounding}" must be absent without Scene State`).not.toContain(grounding);
    }
    // NOW and THEN are labelled in opposite tenses, and the block outranks the
    // archive by position as well as by wording.
    expect(on).toContain("CURRENT SCENE — THIS IS NOW");
    expect(on).toContain("PAST EVENTS");
    expect(on.indexOf("CURRENT SCENE — THIS IS NOW")).toBeLessThan(on.lastIndexOf("Relevant durable memories"));
  });

  it("costs a small bounded number of prompt tokens", () => {
    const deltas = continuityBenchmark.map((testCase) => estimateTokens(promptWith(testCase)) - estimateTokens(promptWithout(testCase)));
    for (const delta of deltas) {
      expect(delta).toBeGreaterThan(0);
      expect(delta).toBeLessThan(250);
    }
    const average = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
    expect(average).toBeLessThan(200);
  });

  it("changes nothing about which memories were selected", () => {
    for (const testCase of continuityBenchmark) {
      const on = promptWith(testCase);
      // Every memory retrieval chose still appears, in the order it chose them.
      let cursor = -1;
      for (const memory of testCase.memories) {
        const at = on.indexOf(memory.content);
        expect(at).toBeGreaterThan(cursor);
        cursor = at;
      }
    }
  });
});
