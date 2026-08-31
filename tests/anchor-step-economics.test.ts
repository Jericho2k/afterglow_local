import { describe, expect, it } from "vitest";
import { anchoredFetchLimit, defaultAnchorStep, estimateTokens, selectAnchoredMessages, selectRecentMessages } from "@/lib/context";
import { serializePayload, sharedPayloadPrefix } from "@/lib/prompt-metrics";
import { buildWriterPrompt, writerMessages } from "@/lib/prompts";
import type { LLMMessage } from "@/lib/llm";
import type { Message } from "@/lib/types";
import { arcs, canon, character, contextMessages, contextTokenBudget, persona, settings, transcript, world } from "./fixtures/cacheable-story";

/**
 * WHAT THE ANCHOR STEP IS WORTH, IN MONEY.
 *
 * The step was eight messages because eight is about four exchanges and that
 * sounded reasonable. It is a cost parameter, so it should be chosen by
 * arithmetic, and this file is that arithmetic run over the real prompt
 * builder rather than over a model of it.
 *
 * The trade has exactly two sides. A SMALLER step re-anchors more often, and
 * every re-anchor moves the window's first message, which invalidates the whole
 * prefix and bills a long request at the fresh rate. A LARGER step carries more
 * transcript in every request — but that extra transcript sits inside the
 * cached prefix, so it is billed at the CACHED rate. At GLM 4.7's DeepInfra
 * rates those two rates differ by five to one, which is what decides it.
 *
 * The output is a table. The assertion is only that the shipped default is not
 * beaten by a materially different one, so this fails if somebody changes the
 * prompt in a way that moves the optimum, rather than quietly asserting a
 * number nobody re-derived.
 */

/** DeepInfra's GLM 4.7 rates, per million tokens. The cheapest eligible host. */
const freshRate = 0.40 / 1_000_000;
const cachedRate = 0.08 / 1_000_000;

const worlds = [world(2_000)];

const lorem = (words: number, seed = 0) =>
  Array.from({ length: words }, (_, index) => `lore${(index + seed) % 97}`).join(" ");

/** One turn's request at a given anchor step. */
function payloadAt(step: number, total: number, turn: number, history: Message[]): LLMMessage[] {
  const prompt = buildWriterPrompt(character, `${lorem(420, turn)} Beat ${turn}.`, Array.from({ length: 8 }, (_, index) => ({
    id: `m${turn}-${index}`, content: lorem(45, turn + index), kind: "event", status: "active", importance: 3, resolution: "", scene: null,
  })) as never, arcs, settings, {
    worlds, persona, coreCanon: canon, sceneState: null, instructionPresets: ["reduce_repetition"], customInstructions: "",
  });
  const available = history.slice(-anchoredFetchLimit(contextMessages, step));
  const conversation = selectAnchoredMessages(available, total, contextMessages, contextTokenBudget, step)
    .map((message) => ({ role: message.role, content: message.content }));
  return writerMessages(prompt, conversation, "tail") as LLMMessage[];
}

/** Cost per turn at one step, averaged over a long stretch of a story. */
function economicsAt(step: number, startMessages: number, turns: number) {
  let previous = payloadAt(step, startMessages, 0, transcript(startMessages));
  let freshTokens = 0;
  let cachedTokens = 0;

  for (let turn = 1; turn <= turns; turn += 1) {
    const total = startMessages + turn * 2;
    const current = payloadAt(step, total, turn, transcript(total));
    const serialized = serializePayload(current);
    const shared = sharedPayloadPrefix(previous, current);
    // What a provider bills: the identical leading run at the cached rate, the
    // rest at the fresh one. Output is the same either way and is left out, so
    // this compares only what the step actually changes.
    cachedTokens += estimateTokens(serialized.slice(0, shared.sharedChars));
    freshTokens += estimateTokens(serialized.slice(shared.sharedChars));
    previous = current;
  }

  const inputCostPerTurn = (freshTokens * freshRate + cachedTokens * cachedRate) / turns;
  return {
    step,
    freshPerTurn: Math.round(freshTokens / turns),
    cachedPerTurn: Math.round(cachedTokens / turns),
    reuse: cachedTokens / (cachedTokens + freshTokens),
    inputCostPerTurn,
  };
}

describe("choosing the anchor step", () => {
  it("prices every candidate step against the real prompt", () => {
    const candidates = [2, 4, 8, 12, 16, 24, 32];
    const rows = candidates.map((step) => economicsAt(step, 120, 24));

    const lines = ["step   reuse   fresh/turn  cached/turn   input $/turn   $/100 turns"];
    for (const row of rows) {
      lines.push([
        String(row.step).padStart(4),
        `${(row.reuse * 100).toFixed(1)}%`.padStart(8),
        row.freshPerTurn.toLocaleString().padStart(11),
        row.cachedPerTurn.toLocaleString().padStart(12),
        `$${row.inputCostPerTurn.toFixed(6)}`.padStart(15),
        `$${(row.inputCostPerTurn * 100).toFixed(4)}`.padStart(14),
      ].join(""));
    }
    console.log(`\nANCHOR STEP ECONOMICS — GLM 4.7 at DeepInfra rates, input only\n${lines.join("\n")}\n`);

    const shipped = rows.find((row) => row.step === defaultAnchorStep);
    const best = rows.reduce((a, b) => (b.inputCostPerTurn < a.inputCostPerTurn ? b : a));
    expect(shipped).toBeDefined();

    /*
     * The shipped default must be within a tenth of the best candidate.
     *
     * Deliberately a band rather than "must BE the best": the optimum shifts
     * with reply length, and a test that demanded the exact minimum would make
     * this constant hostage to the fixture's prose. What must not happen is the
     * default drifting somewhere materially worse without anybody noticing.
     */
    expect(shipped!.inputCostPerTurn).toBeLessThan(best.inputCostPerTurn * 1.1);

    // The measurement that justified moving off eight in the first place.
    const eight = rows.find((row) => row.step === 8)!;
    expect(shipped!.inputCostPerTurn).toBeLessThan(eight.inputCostPerTurn);
  });

  it("never buys cache with context, at any step", () => {
    /*
     * THE INVARIANT THAT MAKES THE WHOLE MECHANISM SAFE TO TUNE.
     *
     * Rounding the window's start DOWN can only move it earlier, so the
     * anchored window always contains every message the budget rule alone would
     * have selected. Whatever the step, the writer never receives less
     * transcript than it would without anchoring — which is why a bigger step
     * is a cost decision rather than a continuity one.
     */
    for (const step of [2, 8, 16, 32]) {
      for (let total = 4; total <= 200; total += 7) {
        const history = transcript(total);
        const available = history.slice(-anchoredFetchLimit(contextMessages, step));
        const baseline = selectRecentMessages(available, contextMessages, contextTokenBudget);
        const anchored = selectAnchoredMessages(available, total, contextMessages, contextTokenBudget, step);
        const ids = new Set(anchored.map((item) => item.id));
        for (const message of baseline) expect(ids.has(message.id), `step=${step} total=${total} dropped ${message.id}`).toBe(true);
        // And it is bounded: at most step-1 extra messages, so the window can
        // never run away.
        expect(anchored.length - baseline.length).toBeLessThan(step);
      }
    }
  });

  it("clamps an operator override rather than trusting it", async () => {
    const { anchorStepFor } = await import("@/lib/context");
    const original = process.env.TRANSCRIPT_ANCHOR_STEP;
    try {
      process.env.TRANSCRIPT_ANCHOR_STEP = "0";
      // Below 2 the anchor moves every turn and the mechanism is simply off.
      expect(anchorStepFor()).toBe(2);
      process.env.TRANSCRIPT_ANCHOR_STEP = "10000";
      // An unbounded value would put a very long transcript in every request.
      expect(anchorStepFor()).toBe(64);
      process.env.TRANSCRIPT_ANCHOR_STEP = "not a number";
      expect(anchorStepFor()).toBe(defaultAnchorStep);
    } finally {
      if (original === undefined) delete process.env.TRANSCRIPT_ANCHOR_STEP;
      else process.env.TRANSCRIPT_ANCHOR_STEP = original;
    }
  });
});
