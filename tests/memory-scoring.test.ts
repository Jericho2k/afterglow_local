import { describe, expect, it } from "vitest";
import { rankMemories } from "@/lib/memory";
import { hybridRankMemories } from "@/lib/memory-v2";
import {
  isStaleCommitment, pinnedTierBudget, pinnedTierLimit, protectedTierBudget, protectedTierLimit,
  recencyScore, recencyWeight, staleCommitmentMessages, staleCommitmentStoryDays, storyDistance,
  type StoryPosition,
} from "@/lib/memory-scoring";
import type { Memory, MemoryKind } from "@/lib/types";

const now = Date.parse("2026-08-30T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

function mem(input: {
  id: string; content?: string; kind?: MemoryKind; ageDays?: number; importance?: number;
  pinned?: boolean; status?: Memory["status"]; keywords?: string[];
  at?: number; storyDay?: number; lastRelevance?: number;
}): Memory {
  return {
    id: input.id, characterId: "c", conversationId: "chat",
    content: input.content ?? `Memory ${input.id}`, kind: input.kind ?? "event",
    importance: input.importance ?? 3, keywords: input.keywords ?? [],
    pinned: input.pinned ?? false, status: input.status ?? "active",
    resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0,
    sourceMessageCount: input.at ?? 0,
    lastRelevanceMatchCount: input.lastRelevance ?? 0,
    scene: typeof input.storyDay === "number" ? { storyDay: input.storyDay, timeOfDay: "", location: "", present: [] } as Memory["scene"] : null,
    createdAt: daysAgo(input.ageDays ?? 0),
  };
}

const noSemantics = new Map<string, number>();
/** The story has run 100 messages and is on fictional day 3. */
const at: StoryPosition = { messageCount: 100, storyDay: 3, now };

/**
 * THE CLOCK THIS SUITE IS ABOUT.
 *
 * A roleplay can sit untouched for three real months while five fictional
 * minutes pass. Aging on the wall clock made that reader come back to a
 * character that had forgotten every promise in the scene it was still in.
 */
describe("aging is measured in story, not in calendar time", () => {
  it("does not fade a memory because the reader was away for a year", () => {
    const away = { messageCount: 12, storyDay: 1, now };
    const fresh = recencyScore(mem({ id: "a", kind: "event", at: 10, storyDay: 1, ageDays: 0 }), away);
    const abandoned = recencyScore(mem({ id: "b", kind: "event", at: 10, storyDay: 1, ageDays: 365 }), away);
    // The wall clock is a tiebreaker worth a tenth of the score, no more.
    expect(abandoned).toBeGreaterThan(fresh * 0.85);
    expect(abandoned).toBeGreaterThan(recencyWeight * 0.8);
  });

  it("does fade a memory the story itself has moved a long way past", () => {
    const near = recencyScore(mem({ id: "a", kind: "event", at: 95 }), at);
    const far = recencyScore(mem({ id: "b", kind: "event", at: 0 }), { messageCount: 3_000, storyDay: 3, now });
    expect(far).toBeLessThan(near / 2);
  });

  it("fades a passing event faster than an identity or a boundary", () => {
    const distant = { messageCount: 1_500, storyDay: 200, now };
    const event = recencyScore(mem({ id: "e", kind: "event", at: 0, storyDay: 0 }), distant);
    const identity = recencyScore(mem({ id: "i", kind: "identity", at: 0, storyDay: 0 }), distant);
    const boundary = recencyScore(mem({ id: "b", kind: "boundary", at: 0, storyDay: 0 }), distant);
    expect(identity).toBeGreaterThan(event);
    expect(boundary).toBeGreaterThan(event);
  });

  it("lets fictional time age a memory even when few messages were spent", () => {
    // Twenty messages, but a year of story: a montage.
    const montage = { messageCount: 20, storyDay: 365, now };
    const byStoryTime = storyDistance(mem({ id: "e", kind: "event", at: 0, storyDay: 0 }), montage);
    expect(byStoryTime).toBeGreaterThan(1);
  });

  it("gives a memory at the current point in the story the full weight", () => {
    for (const kind of ["identity", "event", "boundary", "open_loop"] as MemoryKind[]) {
      expect(recencyScore(mem({ id: kind, kind, at: 100, storyDay: 3, ageDays: 0 }), at)).toBeCloseTo(recencyWeight, 4);
    }
  });

  it("is worth enough to separate two equally relevant memories", () => {
    // The old component maxed out at 2 against a semantic term worth 45, so it
    // could not reorder anything. This is the check that it now can.
    expect(recencyWeight).toBeGreaterThan(4);
    const near = mem({ id: "near", kind: "event", at: 99, content: "They argued about the ferry." });
    const far = mem({ id: "far", kind: "event", at: 0, content: "They argued about the ferry." });
    const ranked = hybridRankMemories([far, near], "the ferry", noSemantics, 1, 4_000, at);
    expect(ranked.selected[0]?.id).toBe("near");
  });
});

describe("a commitment goes quiet in story distance, and proves itself independently", () => {
  it("treats a promise the story has run a long way past as stale", () => {
    const far: StoryPosition = { messageCount: staleCommitmentMessages() + 50, storyDay: 3, now };
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", at: 0 }), far)).toBe(true);
    expect(isStaleCommitment(mem({ id: "l", kind: "open_loop", at: 0 }), far)).toBe(true);
  });

  it("treats a promise from long ago in fictional time as stale", () => {
    const later: StoryPosition = { messageCount: 40, storyDay: staleCommitmentStoryDays() + 10, now };
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", at: 0, storyDay: 0 }), later)).toBe(true);
  });

  it("does NOT treat a promise as stale merely because months of real time passed", () => {
    const away: StoryPosition = { messageCount: 30, storyDay: 1, now };
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", at: 20, storyDay: 1, ageDays: 400 }), away)).toBe(false);
  });

  /*
   * THE SELF-REFRESHING LOOP. The protected tier recalls its own members every
   * turn, so recall_count and last_recalled_at can never prove a protected
   * memory still matters. Only an independent match may refresh the clock.
   */
  it("ignores recall traffic the protected tier generated itself", () => {
    const far: StoryPosition = { messageCount: staleCommitmentMessages() + 50, storyDay: 3, now };
    const recalledConstantly = { ...mem({ id: "p", kind: "promise", at: 0 }), recallCount: 900, lastRecalledAt: new Date(now).toISOString() };
    expect(isStaleCommitment(recalledConstantly, far)).toBe(true);
  });

  it("keeps a commitment the story actually returned to", () => {
    const far: StoryPosition = { messageCount: staleCommitmentMessages() + 50, storyDay: 3, now };
    const revisited = mem({ id: "p", kind: "promise", at: 0, lastRelevance: far.messageCount - 20 });
    expect(isStaleCommitment(revisited, far)).toBe(false);
  });

  it("reports which memories earned their place on the query alone", () => {
    const matched = mem({ id: "matched", kind: "promise", at: 90, content: "She promised to return the brass key.", keywords: ["brass key"] });
    const protectedOnly = mem({ id: "quiet", kind: "promise", at: 90, content: "He agreed to repaint the shed one day." });
    const result = hybridRankMemories([matched, protectedOnly], "where is the brass key", noSemantics, 8, 4_000, at);
    expect(result.selected.map((item) => item.id)).toContain("quiet");
    // Both were included; only one of them proved anything.
    expect(result.relevanceMatched).toEqual(["matched"]);
  });

  it("never treats a boundary or a pinned memory as stale", () => {
    const far: StoryPosition = { messageCount: staleCommitmentMessages() + 900, storyDay: 900, now };
    expect(isStaleCommitment(mem({ id: "b", kind: "boundary", at: 0, storyDay: 0 }), far)).toBe(false);
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", at: 0, storyDay: 0, pinned: true }), far)).toBe(false);
  });

  it("lets a relevant memory through a wall of stale open loops", () => {
    const far: StoryPosition = { messageCount: staleCommitmentMessages() + 100, storyDay: 3, now };
    const stale = Array.from({ length: 14 }, (_, index) => mem({
      id: `zombie-${index}`, kind: "open_loop", at: 0,
      content: `They still mean to visit the old lighthouse number ${index} some day.`,
    }));
    const wanted = mem({ id: "wanted", kind: "event", at: far.messageCount - 1, content: "She gave him the brass key to her workshop.", keywords: ["brass key"] });
    const query = "Do you still have the brass key?";

    expect(rankMemories([...stale, wanted], query, 8, 1_200, far).map((item) => item.id)).toContain("wanted");
    expect(hybridRankMemories([...stale, wanted], query, noSemantics, 8, 1_200, far).selected.map((item) => item.id)).toContain("wanted");
  });

  it("keeps a durable boundary even when everything else is crowded out", () => {
    const noise = Array.from({ length: 30 }, (_, index) => mem({ id: `n-${index}`, kind: "event", importance: 5, at: 99, content: `Loud event ${index}.` }));
    const boundary = mem({ id: "limit", kind: "boundary", at: 0, storyDay: 0, content: "He asked never to be woken before dawn." });
    const result = hybridRankMemories([...noise, boundary], "what happened tonight", noSemantics, 8, 1_500, at);
    expect(result.selected.map((item) => item.id)).toContain("limit");
  });
});

describe("no reserve may take the whole budget", () => {
  it("reserves budget for relevance instead of letting commitments take all of it", () => {
    const long = "x".repeat(1_200);
    const commitments = Array.from({ length: 12 }, (_, index) => mem({
      id: `c-${index}`, kind: "promise", at: 99, content: `${long} promise ${index}`,
    }));
    const budget = 4_000;
    const result = hybridRankMemories(commitments, "unrelated question", noSemantics, 8, budget, at);
    expect(result.selected.length).toBeLessThanOrEqual(protectedTierLimit);
    const guaranteedTokens = result.selected.reduce((sum, item) => sum + Math.ceil(item.content.length / 4) + 16, 0);
    expect(guaranteedTokens - Math.ceil(long.length / 4)).toBeLessThanOrEqual(protectedTierBudget(budget) + 32);
  });

  /*
   * THE BUG THIS CLOSES. Pinned memories were added before any budget rule and
   * with no ceiling of their own, so a reader who pinned a dozen long memories
   * left retrieval nothing at all to work with — and then reported that the
   * character had stopped noticing what was in front of it.
   */
  it("bounds pinned memories too, so they cannot starve relevance", () => {
    const long = "x".repeat(1_600);
    const pinned = Array.from({ length: 12 }, (_, index) => mem({
      id: `pin-${index}`, pinned: true, at: 99, content: `${long} pinned note ${index}`,
    }));
    const wanted = mem({ id: "wanted", kind: "event", at: 99, content: "She gave him the brass key.", keywords: ["brass key"] });
    const budget = 6_000;
    const result = hybridRankMemories([...pinned, wanted], "where is the brass key", noSemantics, 8, budget, at);

    const selectedPinned = result.selected.filter((item) => item.id.startsWith("pin-"));
    expect(selectedPinned.length).toBeLessThanOrEqual(pinnedTierLimit);
    const pinnedTokens = selectedPinned.reduce((sum, item) => sum + Math.ceil(item.content.length / 4) + 16, 0);
    expect(pinnedTokens - Math.ceil(long.length / 4)).toBeLessThanOrEqual(pinnedTierBudget(budget) + 32);
    // And the memory the query is actually about still gets in.
    expect(result.selected.map((item) => item.id)).toContain("wanted");
  });

  it("still admits a pinned memory ahead of every other rule", () => {
    const pinned = mem({ id: "pin", pinned: true, at: 99, content: "Remember: her mother's name is Junia." });
    const crowd = Array.from({ length: 20 }, (_, index) => mem({ id: `c-${index}`, kind: "promise", at: 99 }));
    const result = hybridRankMemories([...crowd, pinned], "anything", noSemantics, 8, 900, at);
    expect(result.selected[0]?.id).toBe("pin");
  });
});

describe("retrieval diagnostics", () => {
  it("explains why an unselected candidate lost", () => {
    const rows = Array.from({ length: 12 }, (_, index) => mem({ id: `m-${index}`, content: `Unrelated note ${index}.`, importance: 1, at: 99 }));
    const result = hybridRankMemories(rows, "a completely different subject", noSemantics, 2, 4_000, at);
    const rejected = result.details.filter((detail) => !detail.selected);
    expect(rejected.length).toBeGreaterThan(0);
    for (const detail of rejected) expect(detail.rejection).toBeTruthy();
  });
});
