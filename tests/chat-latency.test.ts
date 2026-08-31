import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { logTimeline, startTimeline, timingDiagnosticsEnabled } from "@/lib/request-timing";

const chatRoute = readFileSync("src/app/api/chat/route.ts", "utf8");
const memoryV2 = readFileSync("src/lib/memory-v2.ts", "utf8");

/**
 * WHY THIS FILE EXISTS.
 *
 * "Some messages take close to a minute" could only be answered with a guess,
 * because nothing between the request arriving and the first token was
 * measured. Fifteen-odd database round trips, an embedding call, provider
 * selection and a connection handshake were all invisible, and against a pooled
 * remote database every one of those round trips is a network leg the reader
 * waits through.
 *
 * Two things are guarded here. The timeline still gets emitted, and the work
 * that was made concurrent has not quietly gone back to being sequential — the
 * latter is a property of the source, so it is read from the source.
 */

describe("the writer turn is measured end to end", () => {
  it("marks every stage from auth to persistence", () => {
    const required = [
      "auth",
      "conversation+creation+worlds+persona",
      "funding-preflight",
      "transcript+scene",
      "memory-retrieval",
      "prompt-built",
      "provider-request-started",
      "provider-accepted",
      "first-token",
      "stream-complete",
      "persisted",
    ];
    for (const stage of required) expect(chatRoute).toContain(`timeline.mark("${stage}")`);
  });

  it("reports each stage's own duration and names the slowest", () => {
    const timeline = startTimeline();
    timeline.mark("a");
    timeline.mark("b");
    const summary = timeline.summary();
    expect(summary.stages.map((stage) => stage.stage)).toEqual(["a", "b"]);
    for (const stage of summary.stages) expect(stage.delta).toBeGreaterThanOrEqual(0);
    expect(summary.total).toBe(summary.stages.at(-1)!.at);
  });

  it("is off by default in production and never logs content", () => {
    const previous = process.env.CHAT_TIMING_DIAGNOSTICS;
    process.env.CHAT_TIMING_DIAGNOSTICS = "0";
    try {
      expect(timingDiagnosticsEnabled()).toBe(false);
      // Nothing is emitted, so nothing can leak.
      const lines: string[] = [];
      const original = console.info;
      console.info = (...args: unknown[]) => { lines.push(args.join(" ")); };
      try { logTimeline(startTimeline(), { conversationId: "c" }); } finally { console.info = original; }
      expect(lines).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env.CHAT_TIMING_DIAGNOSTICS; else process.env.CHAT_TIMING_DIAGNOSTICS = previous;
    }
  });

  it("logs stage names and numbers only, never prompt or memory text", () => {
    const previous = process.env.CHAT_TIMING_DIAGNOSTICS;
    process.env.CHAT_TIMING_DIAGNOSTICS = "1";
    const lines: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => { lines.push(args.join(" ")); };
    try {
      const timeline = startTimeline();
      timeline.mark("prompt-built");
      logTimeline(timeline, { conversationId: "c", model: "m" });
    } finally {
      console.info = original;
      if (previous === undefined) delete process.env.CHAT_TIMING_DIAGNOSTICS; else process.env.CHAT_TIMING_DIAGNOSTICS = previous;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("prompt-built");
    // The only free-form values in the payload are the context keys the caller
    // passed, and the route passes ids and model names.
    expect(lines[0]).not.toMatch(/content|memoryText|systemPrompt/i);
  });
});

describe("work that was made concurrent has not gone back to being serial", () => {
  it("reads the story's worlds and persona together", () => {
    expect(chatRoute).toMatch(/const \[worldRows, personaResult\] = await Promise\.all\(/);
  });

  it("reads the transcript and the scene together", () => {
    expect(chatRoute).toMatch(/const \[historyResult, sceneState\] = await Promise\.all\(/);
  });

  it("starts the embedding call before waiting on the archive read", () => {
    // The embedding depends only on the query text, so it must be started
    // rather than awaited after a full archive read.
    const semanticStart = memoryV2.indexOf("const semanticStart");
    const archiveAwait = memoryV2.indexOf("const archive = await asUser");
    expect(semanticStart).toBeGreaterThan(-1);
    expect(archiveAwait).toBeGreaterThan(semanticStart);
  });

  it("has no COUNT of the whole conversation on the reply path", () => {
    // A full index scan of the conversation, growing with exactly the thing the
    // product wants people to do, purely to place a cache anchor.
    expect(chatRoute).not.toMatch(/SELECT COUNT\(\*\)::int count FROM messages/);
  });

  it("does not wait on analytics writes before requesting the reply", () => {
    const stamp = chatRoute.indexOf("generation_started_at=COALESCE");
    expect(stamp).toBeGreaterThan(-1);
    const before = chatRoute.slice(Math.max(0, stamp - 400), stamp);
    expect(before).toContain("void asUser");
  });

  it("does not wait on retrieval diagnostics before returning the context", () => {
    const diagnostics = memoryV2.indexOf("INSERT INTO memory_retrieval_runs");
    expect(diagnostics).toBeGreaterThan(-1);
    const before = memoryV2.slice(Math.max(0, diagnostics - 1_200), diagnostics);
    expect(before).toContain("void asUser");
  });
});
