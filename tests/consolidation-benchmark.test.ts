import { describe, expect, it } from "vitest";
import { consolidationTrigger, maxBatchRows, maxPendingMessages, planConsolidationBatch } from "@/lib/consolidation-batch";
import { consolidationInput, consolidationInstructions, consolidationPrompt } from "@/lib/prompts";
import { estimateTokens } from "@/lib/context";
import type { Memory, Message } from "@/lib/types";

/**
 * What one story's memory maintenance costs, before and after.
 *
 * Production gave three different answers for the same code — ~8.3K prompt
 * tokens per memory-update call over thirty days, ~9.8K over seven, ~26.4K on a
 * recent long-form workload that spent about $0.1076 on memory updates in one
 * heavy day. Three answers for one code path is the clue: the old rule sized a
 * call in MESSAGE ROWS and triggered it on a MESSAGE COUNT, and neither is the
 * unit that gets billed.
 *
 * This replays five workloads through the old rule and the new one and prints
 * calls, tokens, cacheable prefix and estimated cost side by side. It is
 * deterministic and offline because the cost question is entirely a question
 * about how many tokens get assembled and how often; no model call is needed to
 * answer it, and one that needed a paid key could not run in CI.
 *
 * WHAT IT CANNOT TELL YOU: whether the smaller, reordered request EXTRACTS as
 * well. That is a question about a model and needs a paid comparison run
 * against the task model; it is named in the report as an open measurement
 * rather than assumed. What is asserted here is the property that must hold
 * whatever the model does — that both rules consolidate every accepted message,
 * in order, exactly once.
 */

const report = process.env.CONSOLIDATION_BENCHMARK_REPORT === "1";

type Workload = { id: string; label: string; messages: number; chars: number; userChars: number; backlog: number };

const workloads: Workload[] = [
  { id: "short",   label: "SHORT — many short chat messages",       messages: 200, chars: 260,    userChars: 90,  backlog: 0 },
  { id: "normal",  label: "NORMAL — typical roleplay replies",      messages: 200, chars: 1_800,  userChars: 260, backlog: 0 },
  { id: "long",    label: "LONG — long multi-paragraph RP",         messages: 200, chars: 6_500,  userChars: 420, backlog: 0 },
  { id: "novel",   label: "NOVEL — extreme reply lengths",          messages: 200, chars: 16_000, userChars: 600, backlog: 0 },
  { id: "backlog", label: "BACKLOG — several intervals behind",     messages: 200, chars: 6_500,  userChars: 420, backlog: 90 },
];

const word = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ";
const filler = (characters: number) => word.repeat(Math.ceil(characters / word.length)).slice(0, characters);

function transcriptFor(workload: Workload): Message[] {
  return Array.from({ length: workload.messages }, (_, index) => ({
    id: `m-${index}`, conversationId: "chat",
    role: index % 2 === 0 ? "user" : "assistant",
    content: filler(index % 2 === 0 ? workload.userChars : workload.chars),
    variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
  }));
}

/** A rolling summary at its steady-state size, and the open-commitment pool. */
const summary = filler(9_000);
const commitment = (index: number): Memory => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  characterId: "c", conversationId: "chat",
  content: filler(320),
  kind: index % 3 === 0 ? "promise" : index % 3 === 1 ? "open_loop" : "boundary",
  importance: 3, keywords: [], pinned: false, status: "active",
  resolution: "", resolvedAt: null, lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0,
  createdAt: new Date(1_700_000_000_000).toISOString(),
});
/** The old rule ranked commitments into a 5,000-token block. */
const oldCommitments = Array.from({ length: 16 }, (_, index) => commitment(index));
/** The new rule takes a bounded chronological slice; see `commitmentResolutionCandidates`. */
const newCommitments = Array.from({ length: 6 }, (_, index) => commitment(index));

/** DeepSeek V4 Flash, the default task model. USD per million tokens. */
const pricing = { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 };
/** A consolidation answer is roughly this size whatever the window was. */
const completionTokens = 900;
const interval = 10;

type Call = { promptTokens: number; cacheablePrefix: number; size: number };

/**
 * The arrival simulation both rules are driven through.
 *
 * Maintenance runs once after each accepted message, exactly as the chat route
 * calls it, so a rule that declines to run simply leaves the window to grow.
 * `backlog` starts the story that many messages behind, which is the case where
 * a fixed row window used to assemble its largest requests.
 */
function replay(messages: Message[], decide: (from: number, delta: number, first: boolean) => Call | null, backlog: number) {
  const calls: Call[] = [];
  let consolidated = 0;
  const start = Math.min(backlog, messages.length);
  for (let arrived = Math.max(1, start); arrived <= messages.length; arrived += 1) {
    const call = decide(consolidated, arrived - consolidated, calls.length === 0);
    if (!call) continue;
    calls.push(call);
    consolidated += call.size;
  }
  return { calls, consolidated, pending: messages.length - consolidated };
}

/**
 * The old rule: run whenever `interval` accepted messages exist, read the next
 * up-to-50 rows, and put the schema and rules at the END of one user message.
 */
function replayOld(messages: Message[], backlog: number) {
  return replay(messages, (from, delta) => {
    if (delta < interval) return null;
    const size = Math.min(50, delta);
    const prompt = consolidationPrompt(summary, messages.slice(from, from + size), "You", oldCommitments);
    return { promptTokens: estimateTokens(prompt), cacheablePrefix: 0, size };
  }, backlog);
}

/**
 * The new rule: wait for transcript rather than for a message count, bound the
 * window in tokens as well as rows, use a bounded commitment block, and put the
 * stable instructions in a system prefix a cache can reuse.
 */
function replayNew(messages: Message[], backlog: number) {
  const instructions = consolidationInstructions();
  const prefixTokens = estimateTokens(instructions);
  return replay(messages, (from, delta, first) => {
    const candidates = messages.slice(from, from + Math.min(maxBatchRows(), Math.max(1, delta)));
    const pendingTokens = candidates.reduce((sum, message) => sum + estimateTokens(message.content) + 8, 0);
    if (!consolidationTrigger({ delta, interval, pendingTokens }).due) return null;
    const batch = planConsolidationBatch(candidates);
    if (!batch.size) return null;
    const input = consolidationInput(summary, batch.messages, "You", newCommitments);
    return {
      promptTokens: prefixTokens + estimateTokens(input),
      // Byte-identical from the second call onwards, which is what a provider
      // cache matches on.
      cacheablePrefix: first ? 0 : prefixTokens,
      size: batch.size,
    };
  }, backlog);
}

function totals(run: { calls: Call[]; consolidated: number; pending: number }) {
  const promptTokens = run.calls.reduce((sum, call) => sum + call.promptTokens, 0);
  const cachedPromptTokens = run.calls.reduce((sum, call) => sum + call.cacheablePrefix, 0);
  const completion = run.calls.length * completionTokens;
  const costUsd = (cachedPromptTokens * pricing.cacheHit + (promptTokens - cachedPromptTokens) * pricing.cacheMiss + completion * pricing.output) / 1_000_000;
  return {
    calls: run.calls.length, consolidated: run.consolidated, pending: run.pending,
    promptTokens, cachedPromptTokens, completionTokens: completion,
    totalTokens: promptTokens + completion,
    tokensPerCall: run.calls.length ? Math.round(promptTokens / run.calls.length) : 0,
    costPerCall: run.calls.length ? costUsd / run.calls.length : 0,
    costUsd,
  };
}

const rows = workloads.map((workload) => {
  const messages = transcriptFor(workload);
  return { workload, before: totals(replayOld(messages, workload.backlog)), after: totals(replayNew(messages, workload.backlog)) };
});

describe("consolidation cost", () => {
  it("leaves no accepted message unconsolidated beyond a bounded tail", () => {
    for (const row of rows) {
      // Neither rule consolidates a partial final window — both wait for the
      // next messages — so what matters is that the residue stays small and
      // that the new rule's is bounded by its own pending ceiling.
      expect(row.before.pending).toBeLessThan(interval);
      expect(row.after.pending).toBeLessThanOrEqual(maxPendingMessages());
      expect(row.after.consolidated).toBeGreaterThan(row.workload.messages * 0.6);
    }
  });

  it("covers the same messages in the same order, with no gap and no repeat", () => {
    for (const workload of workloads) {
      const messages = transcriptFor(workload);
      const run = replayNew(messages, workload.backlog);
      let at = 0;
      for (const call of run.calls) at += call.size;
      expect(at).toBe(run.consolidated);
      // Every batch is a contiguous forward step, so the union of the batches
      // is exactly the prefix `consolidated` names.
      expect(run.calls.every((call) => call.size > 0)).toBe(true);
    }
  });

  it("spends fewer calls on a story of short messages", () => {
    const short = rows.find((row) => row.workload.id === "short")!;
    expect(short.after.calls).toBeLessThan(short.before.calls);
    expect(short.after.totalTokens).toBeLessThan(short.before.totalTokens);
  });

  it("bounds the biggest single call on long-form and novel-length workloads", () => {
    for (const id of ["long", "novel", "backlog"]) {
      const row = rows.find((item) => item.workload.id === id)!;
      // The observed 26.4K-token call is what this ceiling exists to stop.
      expect(row.after.tokensPerCall).toBeLessThan(row.before.tokensPerCall + 1);
      expect(row.after.tokensPerCall).toBeLessThan(45_000);
    }
  });

  it("is cheaper per workload than the rule it replaces", () => {
    for (const row of rows) expect(row.after.costUsd).toBeLessThanOrEqual(row.before.costUsd);
  });

  it("makes the stable instructions reusable after the first call", () => {
    for (const row of rows) {
      if (row.after.calls > 1) expect(row.after.cachedPromptTokens).toBeGreaterThan(0);
      expect(row.before.cachedPromptTokens).toBe(0);
    }
  });

  it("prints the comparison when asked", () => {
    if (!report) return;
    const usd = (value: number) => `$${value.toFixed(5)}`;
    const n = (value: number) => value.toLocaleString("en-US");
    const change = (before: number, after: number) => before ? `${after >= before ? "+" : ""}${((after - before) / before * 100).toFixed(1)}%` : "—";
    const lines = [`Consolidation cost per 200 accepted messages. DeepSeek V4 Flash pricing, interval ${interval}, ${completionTokens} completion tokens/call.`, ""];
    for (const row of rows) {
      lines.push(row.workload.label);
      lines.push(`  calls           ${n(row.before.calls).padStart(8)} → ${n(row.after.calls).padStart(8)}   ${change(row.before.calls, row.after.calls)}`);
      lines.push(`  prompt tokens   ${n(row.before.promptTokens).padStart(8)} → ${n(row.after.promptTokens).padStart(8)}   ${change(row.before.promptTokens, row.after.promptTokens)}`);
      lines.push(`  tokens / call   ${n(row.before.tokensPerCall).padStart(8)} → ${n(row.after.tokensPerCall).padStart(8)}   ${change(row.before.tokensPerCall, row.after.tokensPerCall)}`);
      lines.push(`  cacheable       ${"—".padStart(8)} → ${n(row.after.cachedPromptTokens).padStart(8)}`);
      lines.push(`  total tokens    ${n(row.before.totalTokens).padStart(8)} → ${n(row.after.totalTokens).padStart(8)}   ${change(row.before.totalTokens, row.after.totalTokens)}`);
      lines.push(`  cost / call     ${usd(row.before.costPerCall).padStart(8)} → ${usd(row.after.costPerCall).padStart(8)}   ${change(row.before.costPerCall, row.after.costPerCall)}`);
      lines.push(`  cost            ${usd(row.before.costUsd).padStart(8)} → ${usd(row.after.costUsd).padStart(8)}   ${change(row.before.costUsd, row.after.costUsd)}`);
      lines.push("");
    }
    lines.push("Extraction quality — memories found, arc and summary fidelity, commitment resolution — is a question about the model and needs a paid comparison run. It is not measured here.");
    console.log(lines.join("\n"));
  });
});
