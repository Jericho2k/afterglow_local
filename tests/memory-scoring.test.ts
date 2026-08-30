import { describe, expect, it } from "vitest";
import { rankMemories } from "@/lib/memory";
import { hybridRankMemories } from "@/lib/memory-v2";
import { isStaleCommitment, protectedTierBudget, protectedTierLimit, recencyScore, zombieCommitmentDays } from "@/lib/memory-scoring";
import type { Memory, MemoryKind } from "@/lib/types";

const now = Date.parse("2026-08-30T12:00:00.000Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();

function mem(input: { id: string; content?: string; kind?: MemoryKind; ageDays?: number; importance?: number; pinned?: boolean; status?: Memory["status"]; keywords?: string[] }): Memory {
  return {
    id: input.id, characterId: "c", conversationId: "chat",
    content: input.content ?? `Memory ${input.id}`, kind: input.kind ?? "event",
    importance: input.importance ?? 3, keywords: input.keywords ?? [],
    pinned: input.pinned ?? false, status: input.status ?? "active",
    resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0,
    createdAt: daysAgo(input.ageDays ?? 0),
  };
}

const noSemantics = new Map<string, number>();

describe("kind-sensitive staleness", () => {
  it("decays a passing event faster than an identity or a boundary", () => {
    const age = 120;
    const event = recencyScore(mem({ id: "e", kind: "event", ageDays: age }), now);
    const identity = recencyScore(mem({ id: "i", kind: "identity", ageDays: age }), now);
    const boundary = recencyScore(mem({ id: "b", kind: "boundary", ageDays: age }), now);
    expect(identity).toBeGreaterThan(event);
    expect(boundary).toBeGreaterThan(event);
  });

  it("gives a brand-new memory of any kind the same score it always had", () => {
    for (const kind of ["identity", "event", "boundary", "open_loop"] as MemoryKind[]) {
      expect(recencyScore(mem({ id: kind, kind, ageDays: 0 }), now)).toBeCloseTo(2, 6);
    }
  });
});

describe("zombie commitments", () => {
  it("treats a long-untouched promise or open loop as stale", () => {
    const old = zombieCommitmentDays() + 5;
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", ageDays: old }), now)).toBe(true);
    expect(isStaleCommitment(mem({ id: "l", kind: "open_loop", ageDays: old }), now)).toBe(true);
  });

  it("never treats a boundary or a pinned memory as stale", () => {
    const old = zombieCommitmentDays() + 400;
    expect(isStaleCommitment(mem({ id: "b", kind: "boundary", ageDays: old }), now)).toBe(false);
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", ageDays: old, pinned: true }), now)).toBe(false);
  });

  it("keeps a recent commitment guaranteed", () => {
    expect(isStaleCommitment(mem({ id: "p", kind: "promise", ageDays: 2 }), now)).toBe(false);
  });

  /*
   * The failure this exists to prevent: a story accumulates old open loops,
   * each holding a guaranteed slot, and the memory the current scene is
   * actually about never gets retrieved.
   */
  it("lets a relevant memory through a wall of stale open loops", () => {
    const stale = Array.from({ length: 14 }, (_, index) => mem({
      id: `zombie-${index}`, kind: "open_loop", ageDays: zombieCommitmentDays() + 30,
      content: `They still mean to visit the old lighthouse number ${index} some day.`,
    }));
    const wanted = mem({ id: "wanted", kind: "event", ageDays: 1, content: "She gave him the brass key to her workshop.", keywords: ["brass key"] });
    const query = "Do you still have the brass key?";

    const v1 = rankMemories([...stale, wanted], query, 8, 1200, now);
    expect(v1.map((item) => item.id)).toContain("wanted");

    const v2 = hybridRankMemories([...stale, wanted], query, noSemantics, 8, 1200, now);
    expect(v2.selected.map((item) => item.id)).toContain("wanted");
  });

  it("keeps a durable boundary even when everything else is crowded out", () => {
    const noise = Array.from({ length: 30 }, (_, index) => mem({ id: `n-${index}`, kind: "event", importance: 5, content: `Loud event ${index}.` }));
    const boundary = mem({ id: "limit", kind: "boundary", ageDays: 500, content: "He asked never to be woken before dawn." });
    const v2 = hybridRankMemories([...noise, boundary], "what happened tonight", noSemantics, 8, 1500, now);
    expect(v2.selected.map((item) => item.id)).toContain("limit");
  });
});

describe("bounded protected tier", () => {
  it("reserves budget for relevance instead of letting commitments take all of it", () => {
    const long = "x".repeat(1200);
    const commitments = Array.from({ length: 12 }, (_, index) => mem({
      id: `c-${index}`, kind: "promise", ageDays: 1, content: `${long} promise ${index}`,
    }));
    const budget = 4000;
    const result = hybridRankMemories(commitments, "unrelated question", noSemantics, 8, budget, now);
    // Every one of them is an active promise, so the OLD rule would have taken
    // up to twelve with no token ceiling of their own.
    expect(result.selected.length).toBeLessThanOrEqual(protectedTierLimit);
    const guaranteedTokens = result.selected.reduce((sum, item) => sum + Math.ceil(item.content.length / 4) + 16, 0);
    // The first entry is always admitted; after that the tier stays inside its
    // own share of the budget.
    expect(guaranteedTokens - Math.ceil(long.length / 4)).toBeLessThanOrEqual(protectedTierBudget(budget) + 32);
  });

  it("still admits a pinned memory ahead of every budget rule", () => {
    const pinned = mem({ id: "pin", pinned: true, content: "Remember: her mother's name is Junia." });
    const crowd = Array.from({ length: 20 }, (_, index) => mem({ id: `c-${index}`, kind: "promise", ageDays: 1 }));
    const result = hybridRankMemories([...crowd, pinned], "anything", noSemantics, 8, 900, now);
    expect(result.selected[0]?.id).toBe("pin");
  });
});

describe("retrieval diagnostics", () => {
  it("explains why an unselected candidate lost", () => {
    const rows = Array.from({ length: 12 }, (_, index) => mem({ id: `m-${index}`, content: `Unrelated note ${index}.`, importance: 1 }));
    const result = hybridRankMemories(rows, "a completely different subject", noSemantics, 2, 4000, now);
    const rejected = result.details.filter((detail) => !detail.selected);
    expect(rejected.length).toBeGreaterThan(0);
    for (const detail of rejected) expect(detail.rejection).toBeTruthy();
  });
});
