import { describe, expect, it } from "vitest";
import { rankMemories } from "@/lib/memory";
import type { Memory } from "@/lib/types";

const base = { characterId: "c", conversationId: "x", kind: "event" as const, importance: 3, pinned: false, createdAt: new Date().toISOString() };
const memory = (id: string, content: string, keywords: string[] = [], extra: Partial<Memory> = {}): Memory => ({ ...base, id, content, keywords, ...extra });

describe("rankMemories", () => {
  it("prioritizes exact journal keyword matches", () => {
    const result = rankMemories([
      memory("rain", "They first met during a storm in Paris.", ["Paris café"]),
      memory("tea", "The user prefers jasmine tea.", ["tea"]),
    ], "Do you remember the Paris café?");
    expect(result[0]?.id).toBe("rain");
  });

  it("always recalls pinned memories", () => {
    const result = rankMemories([memory("pinned", "An otherwise unrelated boundary.", [], { pinned: true })], "Hello there");
    expect(result.map((item) => item.id)).toContain("pinned");
  });

  it("does not count pinned memories against the recall limit", () => {
    const result = rankMemories([
      memory("p1", "Pinned one", [], { pinned: true }), memory("p2", "Pinned two", [], { pinned: true }),
      memory("match", "They promised to return to Paris.", ["Paris"], { kind: "promise" }),
    ], "Paris", 1);
    expect(result.map((item) => item.id)).toEqual(expect.arrayContaining(["p1", "p2", "match"]));
  });

  it("recalls important milestones and open commitments without exact keywords", () => {
    const result = rankMemories([
      memory("first", "They shared their first consensual night together after the festival.", [], { importance: 5 }),
      memory("promise", "Yuna promised to tell Rika the truth next week.", [], { kind: "promise", importance: 3 }),
    ], "She quietly asks what happens now.");
    expect(result.map((item) => item.id)).toEqual(expect.arrayContaining(["first", "promise"]));
  });

  it("does not flood context with irrelevant low-signal memories", () => {
    const result = rankMemories([memory("irrelevant", "A distant unrelated astronomy fact.", [], { importance: 1 })], "Would you like coffee?");
    expect(result).toHaveLength(0);
  });
});
