import { describe, expect, it } from "vitest";
import { anchoredFetchLimit, anchorStep, estimateTokens, selectAnchoredMessages, selectRecentMessages, sharedPrefixRatio } from "@/lib/context";
import { inferenceSessionId } from "@/lib/inference-session";
import type { Message } from "@/lib/types";

/**
 * Whether the prompt actually got more cacheable.
 *
 * "We improved caching" is not a claim source code can support — a provider
 * charges for whatever prefix changed, so the only honest measurement is the
 * prefix itself. These tests simulate a long conversation turn by turn and
 * measure, in numbers, how much of one turn's transcript the next turn reuses
 * byte-for-byte.
 *
 * The second thing they guard is the price of that: the anchored window must
 * never contain LESS transcript than the rule it replaced. Buying cache hits
 * with context would be the wrong trade, and this is where that would be
 * caught.
 */

function message(index: number, words = 90): Message {
  return {
    id: `m-${index}`,
    conversationId: "c",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Turn ${index}. ${"scene ".repeat(words)}`.trim(),
    variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
    createdAt: new Date(1_700_000_000_000 + index * 60_000).toISOString(),
  };
}

const contextMessages = 30;
const tokenBudget = 12_000;

/** The rows the route reads at a given point in a conversation's life. */
function availableAt(total: number, limit: number) {
  const all = Array.from({ length: total }, (_, index) => message(index));
  return all.slice(-limit);
}

function runTurns(count: number, startAt: number, select: (available: Message[], total: number) => Message[]) {
  const windows: Message[][] = [];
  for (let turn = 0; turn < count; turn += 1) {
    const total = startAt + turn * 2;
    windows.push(select(availableAt(total, anchoredFetchLimit(contextMessages)), total));
  }
  return windows;
}

function averagePrefixRatio(windows: Message[][]) {
  let sum = 0;
  for (let index = 1; index < windows.length; index += 1) sum += sharedPrefixRatio(windows[index - 1], windows[index]);
  return sum / (windows.length - 1);
}

describe("transcript prefix stability", () => {
  it("measures how badly the sliding window destroys the prefix", () => {
    // The baseline, for contrast. Once the budget saturates, every turn drops
    // a message from the FRONT, so the very first token differs each time.
    const windows = runTurns(12, 120, (available) => selectRecentMessages(available, contextMessages, tokenBudget));
    expect(averagePrefixRatio(windows)).toBeLessThan(0.05);
  });

  it("keeps most of the prefix intact once the window is anchored", () => {
    const windows = runTurns(12, 120, (available, total) => selectAnchoredMessages(available, total, contextMessages, tokenBudget));
    const ratio = averagePrefixRatio(windows);
    // Between anchor steps the window is append-only, so the prefix survives
    // completely; it is lost only on the turns that re-anchor.
    expect(ratio).toBeGreaterThan(0.6);
  });

  it("re-anchors on a schedule rather than on every turn", () => {
    const windows = runTurns(24, 120, (available, total) => selectAnchoredMessages(available, total, contextMessages, tokenBudget));
    let breaks = 0;
    for (let index = 1; index < windows.length; index += 1) {
      if (sharedPrefixRatio(windows[index - 1], windows[index]) < 1) breaks += 1;
    }
    // 24 turns is 48 messages; at a step of 8 that is a handful of breaks, not
    // one per turn.
    expect(breaks).toBeGreaterThan(0);
    expect(breaks).toBeLessThanOrEqual(Math.ceil(48 / anchorStep) + 1);
  });
});

describe("the anchored window never costs context", () => {
  it("always contains every message the budget rule would have selected", () => {
    for (let total = 4; total <= 200; total += 3) {
      const available = availableAt(total, anchoredFetchLimit(contextMessages));
      const baseline = selectRecentMessages(available, contextMessages, tokenBudget);
      const anchored = selectAnchoredMessages(available, total, contextMessages, tokenBudget);
      const anchoredIds = new Set(anchored.map((item) => item.id));
      for (const item of baseline) {
        expect(anchoredIds.has(item.id), `total=${total} dropped ${item.id}`).toBe(true);
      }
      expect(anchored.length).toBeGreaterThanOrEqual(baseline.length);
    }
  });

  it("bounds the extra transcript it carries", () => {
    for (let total = 60; total <= 200; total += 7) {
      const available = availableAt(total, anchoredFetchLimit(contextMessages));
      const baseline = selectRecentMessages(available, contextMessages, tokenBudget);
      const anchored = selectAnchoredMessages(available, total, contextMessages, tokenBudget);
      expect(anchored.length - baseline.length).toBeLessThan(anchorStep);
    }
  });

  it("still respects the budget's own shape for short conversations", () => {
    const available = availableAt(6, anchoredFetchLimit(contextMessages));
    expect(selectAnchoredMessages(available, 6, contextMessages, tokenBudget)).toHaveLength(6);
  });

  it("keeps the estimated prompt within a sane multiple of the budget", () => {
    const available = availableAt(200, anchoredFetchLimit(contextMessages));
    const anchored = selectAnchoredMessages(available, 200, contextMessages, tokenBudget);
    const used = anchored.reduce((sum, item) => sum + estimateTokens(item.content), 0);
    expect(used).toBeLessThan(tokenBudget * 1.5);
  });
});

describe("session identity", () => {
  it("is stable, scoped per task and absent where stickiness cannot help", () => {
    const conversation = "cccccccc-0000-4000-8000-000000000001";
    const rp = inferenceSessionId("rp_generation", conversation);
    const scene = inferenceSessionId("scene_state", conversation);

    expect(rp).toBe(inferenceSessionId("rp_generation", conversation));
    // Two tasks over the same conversation share no prompt prefix, so pooling
    // them under one identifier would ask for a cache that can never hit.
    expect(scene).not.toBe(rp);
    expect(inferenceSessionId("rp_generation", "cccccccc-0000-4000-8000-000000000002")).not.toBe(rp);
    // One-shot and batch work gets no session at all rather than a random one.
    expect(inferenceSessionId("character_import", conversation)).toBeUndefined();
    expect(inferenceSessionId("memory_consolidation", conversation)).toBeUndefined();
    expect(inferenceSessionId("rp_generation", null)).toBeUndefined();
  });

  it("carries nothing that identifies the account or the conversation", () => {
    const conversation = "cccccccc-0000-4000-8000-000000000001";
    const id = inferenceSessionId("rp_generation", conversation) ?? "";
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(id).not.toContain(conversation);
    expect(id).not.toContain("cccccccc");
  });
});
