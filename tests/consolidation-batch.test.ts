import { describe, expect, it, vi } from "vitest";
import { chunkContinuesMarker, chunkResumeMarker, consolidationTrigger, maxBatchRows, maxBatchTokens, maxPendingMessages, minBatchTokens, planConsolidationBatch } from "@/lib/consolidation-batch";
import { estimateTokens } from "@/lib/context";
import type { Message } from "@/lib/types";

function messages(count: number, characters: number, offset = 0): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${offset + index}`, conversationId: "chat",
    role: index % 2 === 0 ? "user" : "assistant",
    content: "w".repeat(characters), variants: [], selectedVariant: 0,
    memoryIds: [], arcIds: [], createdAt: new Date(1_700_000_000_000 + (offset + index) * 1000).toISOString(),
  }));
}

describe("consolidation trigger", () => {
  it("waits for material rather than spending a call on a handful of one-liners", () => {
    const trigger = consolidationTrigger({ delta: 10, interval: 10, pendingTokens: 300 });
    expect(trigger.due).toBe(false);
    expect(trigger.reason).toBe("waiting_for_material");
  });

  it("runs once enough transcript has accumulated", () => {
    expect(consolidationTrigger({ delta: 10, interval: 10, pendingTokens: minBatchTokens() }).due).toBe(true);
  });

  it("never lets a story of short turns go unconsolidated forever", () => {
    const trigger = consolidationTrigger({ delta: maxPendingMessages(), interval: 10, pendingTokens: 50 });
    expect(trigger.due).toBe(true);
    expect(trigger.reason).toBe("backlog");
  });

  it("honours an explicit refresh even with almost nothing pending", () => {
    expect(consolidationTrigger({ delta: 1, interval: 10, pendingTokens: 5, force: true }).due).toBe(true);
  });

  it("does nothing when there is nothing unseen, forced or not", () => {
    expect(consolidationTrigger({ delta: 0, interval: 10, pendingTokens: 0, force: true }).due).toBe(false);
  });
});

describe("chronological token-aware batching", () => {
  it("takes a chronological prefix, so consecutive batches never skip or repeat", () => {
    const all = messages(40, 4_000);
    const first = planConsolidationBatch(all);
    expect(first.size).toBeGreaterThan(0);
    expect(first.messages.map((item) => item.id)).toEqual(all.slice(0, first.size).map((item) => item.id));

    const second = planConsolidationBatch(all.slice(first.size));
    const covered = [...first.messages, ...second.messages].map((item) => item.id);
    expect(covered).toEqual(all.slice(0, first.size + second.size).map((item) => item.id));
    expect(new Set(covered).size).toBe(covered.length);
  });

  it("stays inside the token ceiling on long-form roleplay", () => {
    const batch = planConsolidationBatch(messages(50, 8_000), { maxTokens: 6_000 });
    expect(batch.tokens).toBeLessThanOrEqual(6_000);
    expect(batch.size).toBeLessThan(50);
    expect(batch.more).toBe(true);
  });

  it("takes every message when a short window fits", () => {
    const all = messages(12, 200);
    const batch = planConsolidationBatch(all);
    expect(batch.size).toBe(12);
    expect(batch.more).toBe(false);
    expect(batch.chunk).toBe(null);
  });

  it("reads a single message larger than the whole window as a chunk, without consuming the row", () => {
    const giant = messages(1, 400_000);
    const batch = planConsolidationBatch([...giant, ...messages(3, 100, 1)], { maxTokens: 5_000 });
    // The row is NOT counted as consolidated: its tail has not been read yet.
    expect(batch.size).toBe(0);
    expect(batch.chunk).toMatchObject({ messageId: "m-0", from: 0, final: false });
    expect(batch.nextOffset).toBeGreaterThan(0);
    expect(batch.tokens).toBeLessThanOrEqual(5_000);
    expect(batch.messages[0].content.endsWith(chunkContinuesMarker)).toBe(true);
    expect(batch.more).toBe(true);
  });

  it("consumes an oversized message in sequential chunks that cover all of it", () => {
    const length = 120_000;
    const giant = messages(1, length);
    const covered: Array<[number, number]> = [];
    let offset = 0;
    let passes = 0;
    while (passes < 200) {
      passes += 1;
      const batch = planConsolidationBatch(giant, { maxTokens: 5_000, startOffset: offset });
      expect(batch.chunk).not.toBe(null);
      covered.push([batch.chunk!.from, batch.chunk!.to]);
      if (batch.chunk!.final) { expect(batch.size).toBe(1); expect(batch.nextOffset).toBe(0); break; }
      expect(batch.size).toBe(0);
      expect(batch.nextOffset).toBeGreaterThan(offset);
      offset = batch.nextOffset;
    }
    // No gap: each chunk starts exactly where the last one ended.
    expect(covered[0][0]).toBe(0);
    for (let index = 1; index < covered.length; index += 1) expect(covered[index][0]).toBe(covered[index - 1][1]);
    // No skipped tail.
    expect(covered.at(-1)![1]).toBe(length);
    // Bounded cost: it terminates in a sane number of passes.
    expect(passes).toBeLessThan(200);
  });

  it("repeats a marked overlap so a fact straddling a boundary is not lost", () => {
    const giant = messages(1, 60_000);
    const second = planConsolidationBatch(giant, { maxTokens: 5_000, startOffset: 4_000 });
    expect(second.messages[0].content).toContain(chunkResumeMarker.trim());
    expect(second.chunk).toMatchObject({ from: 4_000 });
  });

  it("resumes where it stopped rather than restarting, so a crash cannot skip a tail", () => {
    const giant = messages(1, 60_000);
    const resumed = planConsolidationBatch(giant, { maxTokens: 5_000, startOffset: 20_000 });
    expect(resumed.chunk!.from).toBe(20_000);
    expect(resumed.chunk!.to).toBeGreaterThan(20_000);
  });

  it("starts an oversized message on its own pass rather than mixing it into a batch", () => {
    const batch = planConsolidationBatch([...messages(3, 400, 0), ...messages(1, 400_000, 3)], { maxTokens: 5_000 });
    expect(batch.size).toBe(3);
    expect(batch.chunk).toBe(null);
    expect(batch.more).toBe(true);
  });

  it("respects the row ceiling on a backlog of tiny messages", () => {
    const batch = planConsolidationBatch(messages(500, 20), { maxRows: 25 });
    expect(batch.size).toBe(25);
    expect(batch.more).toBe(true);
  });

  it("drains a backlog of short messages in fewer calls than the old fixed 50-row window", () => {
    const backlog = messages(300, 120);
    let consumed = 0; let calls = 0;
    while (consumed < backlog.length && calls < 50) {
      const batch = planConsolidationBatch(backlog.slice(consumed));
      consumed += batch.size; calls += 1;
    }
    expect(consumed).toBe(backlog.length);
    expect(calls).toBeLessThan(Math.ceil(backlog.length / 50));
  });

  it("keeps every message whole when nothing needed clipping", () => {
    const all = messages(6, 1_000);
    const batch = planConsolidationBatch(all);
    expect(batch.messages.map((item) => item.content)).toEqual(all.map((item) => item.content));
    expect(batch.tokens).toBe(all.reduce((sum, item) => sum + estimateTokens(item.content) + 8, 0));
  });
});

describe("operator overrides", () => {
  it("reads its bounds from the environment", () => {
    vi.stubEnv("MEMORY_CONSOLIDATION_MAX_TOKENS", "1234");
    vi.stubEnv("MEMORY_CONSOLIDATION_MAX_ROWS", "7");
    vi.stubEnv("MEMORY_CONSOLIDATION_MIN_TOKENS", "99");
    expect(maxBatchTokens()).toBe(1234);
    expect(maxBatchRows()).toBe(7);
    expect(minBatchTokens()).toBe(99);
    vi.unstubAllEnvs();
  });
});
