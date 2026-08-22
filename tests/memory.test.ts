import { describe, expect, it } from "vitest";
import { acceptedMessageCount, rankArcs, rankMemories } from "@/lib/memory";
import type { Memory, MemoryArc } from "@/lib/types";

const base = { characterId: "c", conversationId: "x", kind: "event" as const, importance: 3, pinned: false, status: "active" as const, resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0, createdAt: new Date().toISOString() };
const memory = (id: string, content: string, keywords: string[] = [], extra: Partial<Memory> = {}): Memory => ({ ...base, id, content, keywords, ...extra });

describe("rankMemories", () => {
  it("does not accept the latest assistant variant for consolidation", () => {
    expect(acceptedMessageCount(11,"assistant")).toBe(10);
    expect(acceptedMessageCount(11,"user")).toBe(11);
  });
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

  it("protects every active promise and open loop from the ordinary event slot limit", () => {
    const result = rankMemories([
      memory("promise", "Mara promised to return the borrowed key.", [], { kind:"promise" }),
      memory("loop", "The sealed letter still has not been opened.", [], { kind:"open_loop" }),
      memory("event", "They once visited a gallery.", ["gallery"], { importance:5 }),
    ], "gallery", 1, 2000);
    expect(result.map((item) => item.id)).toEqual(expect.arrayContaining(["promise","loop","event"]));
  });

  it("keeps resolved commitments searchable without forcing them into every reply", () => {
    const resolved = memory("resolved", "Mara promised to return the borrowed key.", ["borrowed key"], { kind:"promise", status:"resolved", resolution:"She returned it at the station." });
    expect(rankMemories([resolved],"Hello",8,2000)).toHaveLength(0);
    expect(rankMemories([resolved],"What happened to the borrowed key?",8,2000).map((item) => item.id)).toEqual(["resolved"]);
  });

  it("retrieves a relevant historical arc regardless of its age", () => {
    const arcs: MemoryArc[] = Array.from({ length: 400 },(_,index) => ({
      id:String(index),conversationId:"x",summary:index === 0 ? "They found the silver compass beneath the old pier." : `Routine chapter ${index}`,
      keywords:index === 0 ? ["silver compass"] : [],startMessageCount:index,endMessageCount:index + 1,
      createdAt:new Date(Date.now() - (400 - index) * 86_400_000).toISOString(),
    }));
    expect(rankArcs(arcs,"Where is the silver compass?",4,1800).map((arc) => arc.id)).toContain("0");
  });
});
