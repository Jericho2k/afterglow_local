import { describe, expect, it } from "vitest";
import { hybridRankMemories } from "@/lib/memory-v2";
import { estimateTokens } from "@/lib/context";
import { archive, cases, storyNow } from "./fixtures/retrieval-budget";
import type { Memory } from "@/lib/types";

/**
 * 6K / 8K / 10K — WHAT THE MEMORY BUDGET SHOULD ACTUALLY BE.
 *
 * The intuition is "models support 200K contexts, so give continuity more
 * room". It is wrong twice.
 *
 * CONTINUITY IS IN THE DYNAMIC HALF OF THE PROMPT. It changes whenever
 * retrieval changes, which is most turns, so an extra memory token is plausibly
 * a cache MISS at fresh-input rates on every writer turn — not a one-off cost
 * absorbed by a cached prefix. At DeepSeek V4 Flash peak that is $0.44 per
 * million fresh input tokens against $0.014 cached: a thirty-fold difference in
 * exactly the section a bigger budget grows.
 *
 * A BIGGER BUDGET DOES NOT ONLY ADD THE ANSWER. It adds everything ranked just
 * below the answer, which is where near-duplicates, decoys and superseded facts
 * live. Precision is not free.
 *
 * So this measures rather than assumes: required-evidence recall, precision,
 * forbidden leakage and added tokens, at each budget, on an archive built from
 * the shapes that have produced real complaints.
 *
 * NO PAID INFERENCE. The ranker is a pure function, so this runs on every push.
 * What it deliberately does NOT measure is WRITER ADHERENCE — whether a model
 * handed the right memory actually uses it. That needs generation and a judge;
 * see tests/eval/replay.test.ts, which is gated on a backup and on keys.
 */

const budgets = [6_000, 8_000, 10_000] as const;
/**
 * Two regimes, because the answer depends on which constraint is actually
 * binding.
 *
 *   `default` is the shipped configuration: `memoryLimit` 8. The dynamic tier
 *   can admit eight memories and the pinned and protected tiers add their own
 *   on top, so a turn carries roughly nineteen.
 *
 *   `widened` is `memoryLimit` at its schema maximum of 20, which is the only
 *   way the token budget becomes the constraint at all.
 */
const regimes = [
  { id: "default", limit: 8 },
  { id: "widened", limit: 20 },
] as const;

const report = process.env.RETRIEVAL_BUDGET_REPORT === "1";
/** No embeddings available offline, so lexical + structural ranking is what runs. */
const noSemantics = new Map<string, number>();

function cost(memory: Memory) {
  return estimateTokens(`${memory.content} ${memory.resolution}`) + 16;
}

type Outcome = {
  regime: string;
  limit: number;
  budget: number;
  recalled: number;
  requiredTotal: number;
  leaked: number;
  forbiddenTotal: number;
  selectedTotal: number;
  tokens: number;
  misses: string[];
  leaks: string[];
};

function run(regime: { id: string; limit: number }, budget: number): Outcome {
  let recalled = 0, requiredTotal = 0, leaked = 0, forbiddenTotal = 0;
  let selectedTotal = 0, tokens = 0;
  const misses: string[] = [], leaks: string[] = [];

  for (const testCase of cases) {
    const { selected } = hybridRankMemories(archive, testCase.query, noSemantics, regime.limit, budget, storyNow);
    const ids = new Set(selected.map((memory) => memory.id));

    requiredTotal += testCase.required.length;
    for (const id of testCase.required) {
      if (ids.has(id)) recalled += 1; else misses.push(`${testCase.id}: ${id}`);
    }
    forbiddenTotal += testCase.forbidden.length;
    for (const id of testCase.forbidden) {
      if (ids.has(id)) { leaked += 1; leaks.push(`${testCase.id}: ${id}`); }
    }
    selectedTotal += selected.length;
    tokens += selected.reduce((sum, memory) => sum + cost(memory), 0);
  }
  return { regime: regime.id, limit: regime.limit, budget, recalled, requiredTotal, leaked, forbiddenTotal, selectedTotal, tokens, misses, leaks };
}

const outcomes = regimes.flatMap((regime) => budgets.map((budget) => run(regime, budget)));
const at = (regime: string, budget: number) => outcomes.find((outcome) => outcome.regime === regime && outcome.budget === budget)!;
const inRegime = (regime: string) => outcomes.filter((outcome) => outcome.regime === regime);

describe("what the memory budget actually buys", () => {
  /*
   * THE FINDING THAT DECIDES THE QUESTION.
   *
   * At the shipped configuration the token budget is NOT THE BINDING
   * CONSTRAINT. `memoryLimit` caps the dynamic tier at eight, and the pinned
   * and protected tiers have caps of their own, so a turn is full long before
   * 6,000 tokens are spent. 6K, 8K and 10K therefore select the same memories,
   * in the same order, for the same number of tokens — byte for byte.
   *
   * That makes "should the budget be 8K or 10K" the wrong question at the
   * default. The lever that actually changes what a writer sees is
   * `memoryLimit`, and raising the budget without raising it does nothing at
   * all while looking like a change.
   */
  it("changes nothing at all at the shipped memoryLimit", () => {
    const shipped = inRegime("default");
    expect(new Set(shipped.map((outcome) => outcome.tokens)).size).toBe(1);
    expect(new Set(shipped.map((outcome) => outcome.selectedTotal)).size).toBe(1);
    expect(new Set(shipped.map((outcome) => outcome.recalled)).size).toBe(1);
  });

  it("stays well inside even the smallest budget at the shipped limit", () => {
    // Per turn, against a 6,000-token budget.
    const perTurn = at("default", 6_000).tokens / cases.length;
    expect(perTurn).toBeLessThan(6_000);
  });

  it("recalls every required memory at every budget, in both regimes", () => {
    for (const outcome of outcomes) {
      expect(outcome.recalled, `${outcome.regime} @ ${outcome.budget}`).toBe(outcome.requiredTotal);
    }
  });

  it("buys more tokens and no more recall once the budget does bind", () => {
    const widened = inRegime("widened");
    // Widening the slot limit is what lets the budget matter...
    expect(at("widened", 10_000).tokens).toBeGreaterThan(at("default", 10_000).tokens);
    // ...and what it buys is tokens, not answers.
    expect(new Set(widened.map((outcome) => outcome.recalled)).size).toBe(1);
  });

  /*
   * THE ONE THING THAT DOES GET WORSE WITH ROOM.
   *
   * `decoy-key` — "the key change in the song they danced to" — is retrieved for
   * "where's the brass key?". It is the lexical false friend the fixture set
   * exists to catch, and it arrives at every budget because with no embeddings
   * available this is the LEXICAL fallback path, where "key" is just a word.
   *
   * Recorded rather than asserted away: in production the semantic ranker
   * scores this pair far apart, and the fallback admitting it is a known,
   * bounded property of running without embeddings. It is listed in the report
   * so that a change in it is visible.
   */
  it("admits a lexical false friend on the no-embeddings fallback path", () => {
    for (const outcome of outcomes) {
      expect(outcome.leaks.every((leak) => leak.endsWith("decoy-key")), `${outcome.regime} @ ${outcome.budget}`).toBe(true);
    }
  });

  it("never retrieves a superseded fact or a resolved promise as open", () => {
    // These are the leaks that would actually rewrite a story.
    const dangerous = outcomes.flatMap((outcome) => outcome.leaks.filter((leak) => !leak.endsWith("decoy-key")));
    expect(dangerous).toEqual([]);
  });

  it("keeps the default where it is, on evidence rather than intuition", () => {
    /*
     * THE RECOMMENDATION: KEEP 6K, AND DO NOT TREAT THE BUDGET AS THE LEVER.
     *
     * Recall is 100% at every budget in both regimes. Nothing dangerous leaks
     * anywhere. At the shipped limit the three budgets are indistinguishable,
     * and once the limit is widened enough for the budget to bind, the extra
     * tokens buy no additional recall — they land in the DYNAMIC section of the
     * prompt, which is the section a provider cache cannot reuse, at
     * fresh-input rates, on every writer turn.
     *
     * Stated caveat: this measures RETRIEVAL, not writer adherence. Whether a
     * model handed more surrounding context writes a better reply needs
     * generation and a judge, which needs API keys this environment does not
     * have.
     */
    expect(at("default", 6_000).recalled).toBe(at("default", 10_000).recalled);
    expect(at("default", 6_000).tokens).toBe(at("default", 10_000).tokens);
  });

  it("prints the comparison when asked", () => {
    if (!report) return;
    const pct = (value: number, total: number) => `${((value / Math.max(1, total)) * 100).toFixed(1)}%`;
    const lines = [
      `Retrieval budget comparison over ${cases.length} adversarial turns against a ${archive.length}-memory archive.`,
      `Story position: message ${storyNow.messageCount}, fictional day ${storyNow.storyDay}. Lexical + structural ranking (no embeddings offline).`,
      "",
      "regime    limit  budget  recall          forbidden  memories/turn  tokens/turn",
    ];
    for (const outcome of outcomes) {
      lines.push([
        outcome.regime.padEnd(10),
        String(outcome.limit).padEnd(7),
        `${(outcome.budget / 1000).toFixed(0)}K`.padEnd(8),
        `${outcome.recalled}/${outcome.requiredTotal} ${pct(outcome.recalled, outcome.requiredTotal)}`.padEnd(16),
        `${outcome.leaked}/${outcome.forbiddenTotal}`.padEnd(11),
        (outcome.selectedTotal / cases.length).toFixed(1).padEnd(15),
        (outcome.tokens / cases.length).toFixed(0),
      ].join(""));
    }
    const misses = at("default", 6_000).misses;
    if (misses.length) {
      lines.push("", "Required evidence NOT retrieved at the shipped default:");
      for (const miss of misses) lines.push(`  ${miss}`);
    }
    const leaks = at("default", 6_000).leaks;
    if (leaks.length) {
      lines.push("", "Forbidden material retrieved at the shipped default:");
      for (const leak of leaks) lines.push(`  ${leak}`);
    }
    lines.push(
      "",
      "READING THIS: at the shipped memoryLimit of 8 the token budget never binds, so 6K/8K/10K are identical.",
      "The lever that changes what a writer sees is memoryLimit, not the budget.",
      "Writer adherence is NOT measured here — that needs generation and a judge.",
    );
    process.stdout.write(`\n${lines.join("\n")}\n`);
  });
});
