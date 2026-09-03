import { describe, expect, it } from "vitest";
import { buildWriterCacheProbe, compareWriterCacheProbe, parseWriterCacheProbe } from "@/lib/cache-probe";
import type { LLMMessage } from "@/lib/llm";

function messages(...rows: Array<[LLMMessage["role"], string]>): LLMMessage[] {
  return rows.map(([role, content]) => ({ role, content }));
}

describe("privacy-safe writer cache probe", () => {
  it("credits an identical request as structurally reusable", () => {
    const current = buildWriterCacheProbe(messages(
      ["system", "stable rules"],
      ["user", "hello"],
      ["assistant", "hi"],
      ["user", "again"],
    ), "glm-5.3-flash", "z-ai");
    const comparison = compareWriterCacheProbe(current, current);
    expect(comparison.previousAvailable).toBe(true);
    expect(comparison.structuralRatio).toBe(1);
    expect(comparison.sharedMessages).toBe(current.messages.length);
    expect(comparison.anchorMoved).toBe(false);
  });

  it("measures only the unchanged leading messages when a turn advances", () => {
    const previous = buildWriterCacheProbe(messages(
      ["system", "stable rules"],
      ["user", "first"],
      ["assistant", "first answer"],
      ["system", "continuity one"],
      ["user", "second"],
    ), "glm-5.3-flash", "z-ai");
    const current = buildWriterCacheProbe(messages(
      ["system", "stable rules"],
      ["user", "first"],
      ["assistant", "first answer"],
      ["user", "second"],
      ["assistant", "second answer"],
      ["system", "continuity two"],
      ["user", "third"],
    ), "glm-5.3-flash", "z-ai");

    const comparison = compareWriterCacheProbe(previous, current);
    expect(comparison.sharedMessages).toBe(3);
    expect(comparison.structuralPrefixTokens).toBeGreaterThan(0);
    expect(comparison.structuralRatio).toBeGreaterThan(0);
    expect(comparison.structuralRatio).toBeLessThan(1);
    expect(comparison.anchorMoved).toBe(false);
  });

  it("marks a transcript anchor change", () => {
    const previous = buildWriterCacheProbe(messages(
      ["system", "stable"],
      ["user", "old anchor"],
      ["assistant", "answer"],
    ), "glm-5.3-flash", "z-ai");
    const current = buildWriterCacheProbe(messages(
      ["system", "stable"],
      ["user", "new anchor"],
      ["assistant", "later answer"],
    ), "glm-5.3-flash", "z-ai");

    const comparison = compareWriterCacheProbe(previous, current);
    expect(comparison.anchorMoved).toBe(true);
    expect(comparison.sharedMessages).toBe(1);
  });

  it("treats changing upstream providers as a cold comparison boundary", () => {
    const previous = buildWriterCacheProbe(messages(
      ["system", "stable"], ["user", "same request"],
    ), "glm-5.3-flash", "z-ai");
    const current = buildWriterCacheProbe(messages(
      ["system", "stable"], ["user", "same request"],
    ), "glm-5.3-flash", "deepinfra");

    const comparison = compareWriterCacheProbe(previous, current);
    expect(comparison.sameUpstreamOverride).toBe(false);
    expect(comparison.structuralPrefixTokens).toBe(0);
    expect(comparison.structuralRatio).toBe(0);
  });

  it("never serializes private prompt text into the stored probe", () => {
    const secret = "PRIVATE STORY SENTENCE 9f7b3";
    const probe = buildWriterCacheProbe(messages(
      ["system", "rules"],
      ["user", secret],
      ["assistant", "private answer"],
    ), "glm-5.3-flash", "z-ai");

    const serialized = JSON.stringify(probe);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private answer");
    expect(parseWriterCacheProbe(JSON.parse(serialized))).not.toBeNull();
  });
});
