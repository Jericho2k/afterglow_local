import { describe, expect, it } from "vitest";
import { estimateTokens, anchorStep } from "@/lib/context";
import { sharedPayloadPrefix } from "@/lib/prompt-metrics";
import { serializePayload } from "@/lib/prompt-metrics";
import { turnPayload, windowFor, world } from "./fixtures/cacheable-story";

/**
 * HOW MUCH OF EACH TURN A PROVIDER COULD SERVE FROM THE LAST TURN'S CACHE.
 *
 * Everything in this sprint's cost argument rests on one number, and it is not
 * a number source code can be read for: a provider bills for whatever prefix
 * changed, so the only honest measurement is the prefix itself. This file
 * simulates a long conversation turn by turn through the REAL prompt builder
 * and reports, in bytes and tokens, what turn N+1 reuses from turn N.
 *
 * It runs entirely offline. No paid endpoint is called and nothing here proves
 * that a provider ACTUALLY served those tokens from cache — that is a
 * measurement against a live endpoint, and `scripts/glm-routing-benchmark.mjs`
 * is where it lives. What this file establishes is the ceiling: a provider
 * cannot possibly cache more than the prefix that stayed identical, so a bad
 * number here is a prompt-layout bug that no amount of routing can fix.
 *
 * THE TARGET IS NOT A CONSTANT. A conversation four turns old is mostly new
 * material, and demanding 80% reuse from it would be demanding that arithmetic
 * be different. So the assertions below scale with the story's length, and the
 * short-conversation case is measured and reported rather than graded.
 */

const worlds = [world(2_000)];
const layout = "tail" as const;

type TurnMeasurement = {
  turn: number;
  totalMessages: number;
  bytes: number;
  tokens: number;
  sharedBytes: number;
  sharedRatio: number;
  /** Tokens this turn that last turn's cache could not have covered. */
  freshTokens: number;
  anchorMoved: boolean;
};

/**
 * Walk a conversation forward, measuring each consecutive pair.
 *
 * Each step adds one exchange — two messages — which is what a real turn does,
 * and rewrites the dynamic half, which is also what a real turn does.
 */
function walk(startMessages: number, turns: number): TurnMeasurement[] {
  const rows: TurnMeasurement[] = [];
  let previous = turnPayload(startMessages, 0, layout, worlds);
  let previousAnchor = windowFor(startMessages)[0]?.id;

  for (let turn = 1; turn <= turns; turn += 1) {
    const totalMessages = startMessages + turn * 2;
    const current = turnPayload(totalMessages, turn, layout, worlds);
    const shared = sharedPayloadPrefix(previous, current);
    const serialized = serializePayload(current);
    const anchor = windowFor(totalMessages)[0]?.id;

    rows.push({
      turn, totalMessages,
      bytes: serialized.length,
      tokens: estimateTokens(serialized),
      sharedBytes: shared.sharedChars,
      // Measured against the CURRENT request: "what share of what I am about to
      // send could already be warm" is the question a bill answers.
      sharedRatio: serialized.length ? shared.sharedChars / serialized.length : 0,
      freshTokens: estimateTokens(serialized.slice(shared.sharedChars)),
      anchorMoved: anchor !== previousAnchor,
    });

    previous = current;
    previousAnchor = anchor;
  }
  return rows;
}

function report(label: string, rows: TurnMeasurement[]) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const averageRatio = mean(rows.map((row) => row.sharedRatio));
  const averageFresh = mean(rows.map((row) => row.freshTokens));
  const rollovers = rows.filter((row) => row.anchorMoved).length;
  const lines = [
    `${label} — ${rows.length} consecutive turns, "${layout}" layout`,
    `  average reusable prefix   ${(averageRatio * 100).toFixed(1)}%`,
    `  worst turn                ${(Math.min(...rows.map((r) => r.sharedRatio)) * 100).toFixed(1)}%`,
    `  best turn                 ${(Math.max(...rows.map((r) => r.sharedRatio)) * 100).toFixed(1)}%`,
    `  average request           ${Math.round(mean(rows.map((r) => r.tokens))).toLocaleString()} tokens`,
    `  average NEW tokens/turn   ${Math.round(averageFresh).toLocaleString()}`,
    `  anchor rollovers          ${rollovers} in ${rows.length} turns (step ${anchorStep})`,
  ];
  return { text: lines.join("\n"), averageRatio, averageFresh, rollovers };
}

describe("cacheability of consecutive turns", () => {
  it("reuses most of a long conversation's request", () => {
    const rows = walk(120, 24);
    const summary = report("LONG STORY (120 messages in)", rows);
    console.log(`\n${summary.text}\n`);

    /*
     * The acceptance target for this sprint, measured rather than asserted into
     * existence.
     *
     * The residue is not waste. It is the new exchange, the rewritten summary
     * and the rotated memory set — genuinely new content that no layout can
     * make reusable, and which we would not want to make reusable by dropping
     * it. Removing story context to raise this number would be gaming it.
     */
    expect(summary.averageRatio).toBeGreaterThan(0.75);
  });

  it("does not pretend a young conversation can reuse what does not exist yet", () => {
    // Four turns in, most of the request IS the new material. The measurement
    // is still worth printing; grading it against 80% would be demanding that
    // arithmetic be different.
    const rows = walk(6, 4);
    const summary = report("YOUNG STORY (6 messages in)", rows);
    console.log(`\n${summary.text}\n`);
    expect(summary.averageRatio).toBeGreaterThan(0);
    expect(summary.averageRatio).toBeLessThan(0.95);
  });

  it("keeps the newly uncached part of a turn small and roughly constant", () => {
    /*
     * The number a bill is actually proportional to.
     *
     * A request whose reusable share is 80% is still ruinous if the request
     * doubles in size every turn, because 20% of a growing number grows. What
     * makes the economics work is that the fresh remainder stays flat while the
     * request grows: the cost of a turn stops tracking the length of the story.
     */
    const rows = walk(120, 16);
    const fresh = rows.map((row) => row.freshTokens);
    const requests = rows.map((row) => row.tokens);
    expect(Math.min(...requests)).toBeGreaterThan(8_000);
    // Even on a rollover turn the fresh part stays a small fraction of the
    // whole request.
    expect(Math.max(...fresh)).toBeLessThan(Math.min(...requests) * 0.6);
  });
});

describe("the transcript anchor", () => {
  it("moves on a schedule rather than on every turn", () => {
    const rows = walk(120, 24);
    const rollovers = rows.filter((row) => row.anchorMoved).length;
    /*
     * The failure this guards is the sliding window: 1–30, then 2–31, then
     * 3–32. Almost all the text overlaps and none of it is reusable, because
     * the prefix changes at the very first token. An anchored window instead
     * grows 1–30, 1–31, 1–32 and then deliberately jumps.
     *
     * 24 turns is 48 new messages, so at a step of 8 that is a handful of
     * jumps. One per turn would mean the anchoring had stopped working.
     */
    expect(rollovers).toBeGreaterThan(0);
    expect(rollovers).toBeLessThanOrEqual(Math.ceil(48 / anchorStep) + 1);
  });

  it("pays for a rollover once instead of every turn", () => {
    const rows = walk(120, 24);
    const moved = rows.filter((row) => row.anchorMoved);
    const held = rows.filter((row) => !row.anchorMoved);
    expect(moved.length).toBeGreaterThan(0);
    expect(held.length).toBeGreaterThan(moved.length);

    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(`\nAnchor held:  ${(mean(held.map((r) => r.sharedRatio)) * 100).toFixed(1)}% reusable over ${held.length} turns`);
    console.log(`Anchor moved: ${(mean(moved.map((r) => r.sharedRatio)) * 100).toFixed(1)}% reusable over ${moved.length} turns\n`);

    // A rollover is a real cost and is meant to be: it is the price of not
    // carrying the whole story forever. What matters is that it is occasional.
    expect(mean(held.map((r) => r.sharedRatio))).toBeGreaterThan(mean(moved.map((r) => r.sharedRatio)));
  });
});

describe("nothing volatile sits ahead of the reusable prefix", () => {
  it("produces a byte-identical request when the story has not moved", () => {
    /*
     * THE CACHE-BUSTING TEST.
     *
     * A timestamp, a request id, a counter, a re-ordered set or a
     * "the time is now" line anywhere in the head would make two requests for
     * the SAME story state differ, and everything after that point would be
     * billed fresh on every single turn. Assembling the identical turn twice
     * and comparing bytes is the only check that catches all of those at once,
     * including ones nobody thought to grep for.
     */
    const first = turnPayload(140, 7, layout, worlds);
    const second = turnPayload(140, 7, layout, worlds);
    expect(serializePayload(second)).toBe(serializePayload(first));
  });

  it("keeps the stable head identical while the dynamic half moves", () => {
    // Turn to turn, the head must not move at all: it is the part a provider
    // is being asked to hold. Anything in it that tracked the story would
    // strand the entire transcript behind it.
    const before = turnPayload(140, 7, layout, worlds);
    const after = turnPayload(142, 8, layout, worlds);
    expect(after[0].role).toBe("system");
    expect(after[0].content).toBe(before[0].content);
  });

  it("is not quietly measuring an empty prompt", () => {
    // A guard on the guard: if the fixture ever stopped producing a real
    // prompt, every ratio above would pass trivially.
    const payload = turnPayload(140, 7, layout, worlds);
    expect(estimateTokens(serializePayload(payload))).toBeGreaterThan(8_000);
    expect(payload.length).toBeGreaterThan(20);
  });
});
