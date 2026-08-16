import { describe, expect, it } from "vitest";
import { rankMemories } from "@/lib/memory";
import type { Memory } from "@/lib/types";

const base = { characterId: "c", conversationId: "x", importance: 3, pinned: false, createdAt: new Date().toISOString() };
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

  it("does not flood context with irrelevant low-signal memories", () => {
    const result = rankMemories([memory("irrelevant", "A distant unrelated astronomy fact.", [], { importance: 1 })], "Would you like coffee?");
    expect(result).toHaveLength(0);
  });
});
