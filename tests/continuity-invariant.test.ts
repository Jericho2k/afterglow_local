import { describe, expect, it } from "vitest";
import { consolidationTrigger, maxPendingMessages, maxPendingTokens } from "@/lib/consolidation-batch";
import { anchoredFetchLimit, estimateTokens, selectAnchoredMessages } from "@/lib/context";
import type { Message } from "@/lib/types";

/**
 * THE INVARIANT.
 *
 *   Every accepted story message is EITHER already consolidated into continuity
 *   OR still inside the literal transcript sent to the writer. Never neither.
 *
 * The merged defaults broke it in the ordinary case. `maxPendingMessages` was a
 * fixed 60 while `contextMessages` defaulted to 30, so a story of short turns
 * could carry 59 unconsolidated messages against a transcript window holding 30
 * of them. The 29 in between were in neither place: too old for the writer to
 * read, too new for memory to know about. That is a continuity hole in the exact
 * shape of "the model forgot something that happened twenty messages ago".
 *
 * These tests are written against the real trigger and the real transcript
 * selector, so they fail if either side drifts back out of agreement.
 */

function story(count: number, characters: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`, conversationId: "chat",
    role: index % 2 === 0 ? "user" : "assistant",
    content: "w".repeat(characters), variants: [], selectedVariant: 0,
    memoryIds: [], arcIds: [], createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }) as Message);
}

/** How many of the newest messages the writer actually receives. */
function transcriptWindow(total: number, characters: number, contextMessages: number, contextTokenBudget: number) {
  const all = story(total, characters);
  const available = all.slice(-anchoredFetchLimit(contextMessages));
  return selectAnchoredMessages(available, total, contextMessages, contextTokenBudget).length;
}

/**
 * The largest backlog the trigger will tolerate before it insists on a pass:
 * the first `delta` at which consolidation becomes due, minus one.
 */
function largestTolerableBacklog(characters: number, interval: number, contextMessages: number, contextTokenBudget: number) {
  for (let delta = 1; delta <= 2_000; delta += 1) {
    const pendingTokens = delta * (estimateTokens("w".repeat(characters)) + 8);
    const trigger = consolidationTrigger({ delta, interval, pendingTokens, contextMessages, contextTokenBudget });
    if (trigger.due) return delta - 1;
  }
  return 2_000;
}

describe("no accepted message is ever outside the transcript AND unconsolidated", () => {
  const shapes = [
    { name: "one-word turns", characters: 20 },
    { name: "short chat", characters: 120 },
    { name: "ordinary roleplay", characters: 900 },
    { name: "long-form prose", characters: 3_500 },
    { name: "novel-length replies", characters: 11_000 },
  ];
  const settings = [
    { contextMessages: 30, contextTokenBudget: 12_000, interval: 10 },
    { contextMessages: 8, contextTokenBudget: 4_000, interval: 10 },
    { contextMessages: 100, contextTokenBudget: 100_000, interval: 10 },
    // An interval deliberately set near the window: the rails have to win.
    { contextMessages: 30, contextTokenBudget: 12_000, interval: 25 },
  ];

  for (const shape of shapes) {
    for (const setting of settings) {
      it(`holds for ${shape.name} at contextMessages=${setting.contextMessages}/interval=${setting.interval}`, () => {
        const backlog = largestTolerableBacklog(shape.characters, setting.interval, setting.contextMessages, setting.contextTokenBudget);
        const total = Math.max(400, backlog * 3);
        const window = transcriptWindow(total, shape.characters, setting.contextMessages, setting.contextTokenBudget);
        // The newest `backlog` messages may be unconsolidated; the newest
        // `window` are in the transcript. The invariant is backlog <= window.
        expect(backlog).toBeLessThanOrEqual(window);
      });
    }
  }

  it("is what the old fixed ceiling violated", () => {
    // The merged default, reconstructed: a fixed 60 pending against a 30 window.
    const window = transcriptWindow(400, 20, 30, 12_000);
    expect(window).toBeLessThan(60);
    // And what the derived rail gives instead.
    expect(maxPendingMessages(30)).toBeLessThanOrEqual(window);
  });
});

describe("the rails themselves", () => {
  it("derives the message ceiling from the writer's window", () => {
    expect(maxPendingMessages(30)).toBe(19);
    expect(maxPendingMessages(100)).toBe(66);
    // No fixed floor: a floor above the window would recreate the hole.
    expect(maxPendingMessages(8)).toBe(5);
  });

  it("derives a token ceiling too, because long messages leave the window first", () => {
    expect(maxPendingTokens(12_000)).toBe(7_920);
    expect(maxPendingTokens(4_000)).toBe(2_640);
  });

  it("fires on transcript pressure before the interval is reached", () => {
    // Six 2,000-token replies saturate a 12K budget long before ten messages.
    const trigger = consolidationTrigger({
      delta: 5, interval: 10, pendingTokens: 8_400, contextMessages: 30, contextTokenBudget: 12_000,
    });
    expect(trigger.due).toBe(true);
    expect(trigger.reason).toBe("transcript_pressure");
  });

  it("still waits for material in the ordinary short-message case", () => {
    const trigger = consolidationTrigger({
      delta: 10, interval: 10, pendingTokens: 300, contextMessages: 30, contextTokenBudget: 12_000,
    });
    expect(trigger.due).toBe(false);
    expect(trigger.reason).toBe("waiting_for_material");
  });

  it("keeps an explicit operator override", () => {
    const previous = process.env.MEMORY_CONSOLIDATION_MAX_PENDING;
    process.env.MEMORY_CONSOLIDATION_MAX_PENDING = "40";
    try { expect(maxPendingMessages(30)).toBe(40); }
    finally { if (previous === undefined) delete process.env.MEMORY_CONSOLIDATION_MAX_PENDING; else process.env.MEMORY_CONSOLIDATION_MAX_PENDING = previous; }
  });
});
