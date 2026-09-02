import { describe, expect, it } from "vitest";
import { estimateTokens } from "@/lib/context";
import type { LLMMessage } from "@/lib/llm";
import { serializePayload, sharedPayloadPrefix } from "@/lib/prompt-metrics";
import { consolidationInput, consolidationInstructions } from "@/lib/prompts";
import { inferenceSessionId } from "@/lib/inference-session";
import { commitmentsBefore, consolidationPayload, summaryBefore, windowFor } from "./fixtures/consolidation-story";

/**
 * HOW MUCH OF EACH MEMORY JOB A PROVIDER COULD SERVE FROM THE LAST ONE'S CACHE.
 *
 * The writer's prompt already has this measurement (tests/prompt-cacheability),
 * and the background workload never did — which is how it ended up with the
 * extraction rules and the JSON schema at the END of a single user message,
 * behind the transcript, where nothing could ever be cached. That is fixed, and
 * this file is what stops it silently coming back.
 *
 * IT RUNS ENTIRELY OFFLINE, AND WHAT IT MEASURES IS A CEILING. No paid endpoint
 * is called, and nothing here proves a provider ACTUALLY served those tokens
 * from cache — provider-reported `cached_tokens` remains the only authority on
 * that, and it lives in the usage ledger. What this establishes is the limit: a
 * provider cannot possibly reuse more than the prefix that stayed identical, so
 * a bad number here is a prompt-layout bug that no amount of routing can fix.
 *
 * THE TARGET IS NOT 90%, AND IT SHOULD NOT BE. A consolidation job's dynamic
 * half is a rewritten rolling summary plus a window of transcript the model has
 * never seen — several thousand tokens of genuinely new material against
 * roughly a thousand tokens of stable rules. The honest ceiling is therefore
 * much lower than a roleplay turn's, and the way to "improve" it would be to
 * send less memory context, which is the one thing this sprint must not do.
 * So the assertions below pin the STRUCTURE — the stable rules are reused, the
 * divergence lands where it should — rather than chasing a percentage.
 */

const interval = 10;

type JobMeasurement = {
  job: number;
  bytes: number;
  tokens: number;
  sharedBytes: number;
  sharedTokens: number;
  sharedRatio: number;
  freshTokens: number;
  /** Which block the two requests stop agreeing in. */
  divergesIn: "system rules" | "commitments" | "summary" | "transcript";
};

const systemChars = () => `<system>You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}`.length;

/** Where a shared-prefix length lands, named by the block it falls inside. */
function locate(job: number, sharedChars: number): JobMeasurement["divergesIn"] {
  const system = systemChars();
  if (sharedChars < system) return "system rules";
  const user = consolidationInput(summaryBefore(job), windowFor(job, interval), "You", commitmentsBefore(job));
  // The serialisation inserts "\n<user>" between the two messages.
  const offset = sharedChars - system - "\n<user>".length;
  const summaryAt = user.indexOf("Existing summary:");
  const transcriptAt = user.indexOf("New transcript:");
  if (offset < summaryAt) return "commitments";
  if (offset < transcriptAt) return "summary";
  return "transcript";
}

function walk(jobs: number): JobMeasurement[] {
  const rows: JobMeasurement[] = [];
  let previous = consolidationPayload(0, interval);
  for (let job = 1; job <= jobs; job += 1) {
    const current = consolidationPayload(job, interval);
    const shared = sharedPayloadPrefix(previous, current);
    const serialized = serializePayload(current);
    rows.push({
      job,
      bytes: serialized.length,
      tokens: estimateTokens(serialized),
      sharedBytes: shared.sharedChars,
      sharedTokens: estimateTokens(serialized.slice(0, shared.sharedChars)),
      // Measured against the CURRENT request: "what share of what I am about to
      // send could already be warm" is the question a bill answers.
      sharedRatio: serialized.length ? shared.sharedChars / serialized.length : 0,
      freshTokens: estimateTokens(serialized.slice(shared.sharedChars)),
      divergesIn: locate(job, shared.sharedChars),
    });
    previous = current;
  }
  return rows;
}

function report(rows: JobMeasurement[]) {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const staticTokens = estimateTokens(consolidationInstructions());
  const sample = consolidationPayload(rows.length, interval)[1].content;
  const summaryTokens = estimateTokens(summaryBefore(rows.length));
  const transcriptTokens = estimateTokens(windowFor(rows.length, interval).map((message) => message.content).join("\n"));
  const commitmentTokens = estimateTokens(sample.slice(0, sample.indexOf("Existing summary:")));
  const byBlock = new Map<string, number>();
  for (const row of rows) byBlock.set(row.divergesIn, (byBlock.get(row.divergesIn) ?? 0) + 1);
  return [
    `MEMORY CONSOLIDATION — ${rows.length} consecutive jobs, ${interval}-message windows`,
    `  average reusable prefix   ${(mean(rows.map((r) => r.sharedRatio)) * 100).toFixed(1)}%`,
    `  worst job                 ${(Math.min(...rows.map((r) => r.sharedRatio)) * 100).toFixed(1)}%`,
    `  best job                  ${(Math.max(...rows.map((r) => r.sharedRatio)) * 100).toFixed(1)}%`,
    `  average reusable prefix   ${Math.round(mean(rows.map((r) => r.sharedBytes))).toLocaleString()} bytes / ${Math.round(mean(rows.map((r) => r.sharedTokens))).toLocaleString()} tokens`,
    `  average request           ${Math.round(mean(rows.map((r) => r.tokens))).toLocaleString()} tokens`,
    `  average NEW tokens/job    ${Math.round(mean(rows.map((r) => r.freshTokens))).toLocaleString()}`,
    "",
    "  where the request stops matching the previous one:",
    ...[...byBlock.entries()].map(([block, count]) => `    ${block.padEnd(14)} ${count} of ${rows.length} jobs`),
    "",
    "  composition of one job:",
    `    static extraction rules ${staticTokens.toLocaleString()} tokens`,
    `    open commitments        ${commitmentTokens.toLocaleString()} tokens`,
    `    rolling summary         ${summaryTokens.toLocaleString()} tokens`,
    `    new transcript          ${transcriptTokens.toLocaleString()} tokens`,
  ].join("\n");
}

describe("cacheability of consecutive memory jobs", () => {
  it("reuses the whole static extraction prefix on every job", () => {
    const rows = walk(20);
    console.log(`\n${report(rows)}\n`);

    /*
     * THE ONE ASSERTION THAT MATTERS.
     *
     * Every job must reuse at least the entire system message — the task, the
     * schema and the rules — because that block is byte-identical on every
     * consolidation this deployment ever makes. A job that diverges inside it
     * means something non-deterministic got in front of the rules: a timestamp,
     * a request id, a re-serialised object with unstable key order.
     */
    const system = estimateTokens(`You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}`);
    for (const row of rows) {
      expect(row.divergesIn, `job ${row.job} diverged inside the static rules`).not.toBe("system rules");
      expect(row.sharedTokens).toBeGreaterThanOrEqual(system);
    }
  });

  it("puts the slowest-changing dynamic block first, so it can be cached too", () => {
    const rows = walk(20);
    /*
     * The commitments block is identical between most consecutive jobs, and the
     * rolling summary is different between all of them. With the summary first
     * — which is how this used to be built — the commitments could never be
     * reused, because everything behind a changed byte is a cache miss.
     *
     * So most jobs should now diverge in the SUMMARY rather than at the top of
     * the user message, and the ones that diverge in the commitments should be
     * exactly the jobs where a commitment was added or resolved.
     */
    const inSummaryOrLater = rows.filter((row) => row.divergesIn === "summary" || row.divergesIn === "transcript");
    expect(inSummaryOrLater.length).toBeGreaterThan(rows.length / 2);
  });

  it("keeps the newly uncached part flat while the story grows", () => {
    /*
     * The number a bill is actually proportional to.
     *
     * Consolidation is inherently a "new material" job, so its reusable SHARE
     * is modest and always will be. What has to stay true is that the fresh
     * part does not grow with the story: a job at message 500 must not cost
     * more than a job at message 50 merely because there is more story behind
     * it. The rolling summary grows toward its ceiling and then stops, which is
     * exactly why the contract states one.
     */
    const rows = walk(30);
    const early = rows.slice(0, 5).map((row) => row.freshTokens);
    const late = rows.slice(-5).map((row) => row.freshTokens);
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean(late)).toBeLessThan(mean(early) * 3);
  });

  it("is deterministic: the same job serialises to the same bytes twice", () => {
    // A cache figure is meaningless if the request is not reproducible. This is
    // the test that would fail if a timestamp, a random id, an unordered array
    // or an unstable JSON key order ever got into the prompt.
    for (const job of [0, 1, 7, 19]) {
      expect(serializePayload(consolidationPayload(job, interval)))
        .toBe(serializePayload(consolidationPayload(job, interval)));
    }
  });

  it("does not reach a high number by sending less memory context", () => {
    /*
     * The anti-gaming check.
     *
     * A trivially high reusable share is available by dropping the summary, the
     * commitments, or most of the transcript — and it would be a continuity
     * regression sold as a cost win. So the pieces are asserted to be PRESENT
     * and substantial, and the ratio is only meaningful alongside this.
     */
    const [, user] = consolidationPayload(15, interval);
    expect(user.content).toContain("Active protected commitments");
    expect(user.content).toContain("Existing summary:");
    expect(user.content).toContain("New transcript:");
    expect(estimateTokens(summaryBefore(15))).toBeGreaterThan(300);
    expect(commitmentsBefore(15).length).toBeGreaterThan(2);
    expect(windowFor(15, interval)).toHaveLength(interval);
  });
});

/**
 * WHAT THE LAYOUT CHANGES ACTUALLY BOUGHT.
 *
 * Two rearrangements got the request to its current shape, and neither changed
 * one word of what is asked for. This reconstructs the two earlier layouts from
 * the same blocks and measures all three, so the claim in the report is a
 * number rather than an argument.
 *
 * These reconstructions are the one place in this file that does not go through
 * the real builder, and they cannot: the layouts they describe no longer exist
 * in the codebase. They are labelled as history and are never graded — only the
 * current layout has assertions on it.
 */
describe("the layout, measured against the two it replaced", () => {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

  /** Everything in one user message, rules LAST. The original. */
  function everythingInOneMessage(job: number): LLMMessage[] {
    const commitments = commitmentsBefore(job);
    const transcript = windowFor(job, interval).map((m) => `${m.role === "user" ? "You" : "Character"}: ${m.content}`).join("\n\n");
    return [{
      role: "user",
      content: `Existing summary:\n${summaryBefore(job) || "None"}\n\nActive protected commitments:\n${commitments.map((m) => `- ${m.id} [${m.kind}] ${m.content}`).join("\n") || "- None"}\n\nNew transcript:\n${transcript}\n\n${consolidationInstructions()}`,
    }];
  }

  /** Rules moved into the system message; summary still ahead of commitments. */
  function summaryFirst(job: number): LLMMessage[] {
    const commitments = commitmentsBefore(job);
    const transcript = windowFor(job, interval).map((m) => `${m.role === "user" ? "You" : "Character"}: ${m.content}`).join("\n\n");
    return [
      { role: "system", content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
      {
        role: "user",
        content: `Existing summary:\n${summaryBefore(job) || "None"}\n\nActive protected commitments (refer to these only by the exact supplied ID):\n${commitments.map((m) => `- ${m.id} [${m.kind}] ${m.content}`).join("\n") || "- None"}\n\nNew transcript:\n${transcript}`,
      },
    ];
  }

  function averageShare(build: (job: number) => LLMMessage[], jobs = 20) {
    const shares: number[] = [];
    let previous = build(0);
    for (let job = 1; job <= jobs; job += 1) {
      const current = build(job);
      const serialized = serializePayload(current);
      shares.push(sharedPayloadPrefix(previous, current).sharedChars / serialized.length);
      previous = current;
    }
    return mean(shares);
  }

  it("reports the three layouts side by side", () => {
    const original = averageShare(everythingInOneMessage);
    const interim = averageShare(summaryFirst);
    const current = averageShare((job) => consolidationPayload(job, interval));
    console.log([
      "",
      "MEMORY PROMPT LAYOUT — average reusable prefix over 20 consecutive jobs",
      `  rules last, one user message      ${(original * 100).toFixed(1)}%   (the original)`,
      `  rules in system, summary first    ${(interim * 100).toFixed(1)}%   (after the first move)`,
      `  rules in system, commitments first ${(current * 100).toFixed(1)}%  (current)`,
      "",
      "  Nothing was removed between these. The same rules, schema, summary,",
      "  commitments and transcript are sent in all three; only their order moved.",
      "",
    ].join("\n"));

    // The original could reuse essentially nothing: every job's first line was
    // the rewritten summary, so the ~730 tokens of stable rules behind it were
    // re-billed at full price every single time.
    expect(original).toBeLessThan(0.05);
    // Both moves are improvements, and the second is smaller than the first —
    // which is the honest shape of it. Moving the rules is the big win;
    // ordering the dynamic half by change rate is the remainder.
    expect(interim).toBeGreaterThan(original);
    expect(current).toBeGreaterThan(interim);
  });
});

describe("the memory inference session", () => {
  it("gives one conversation one stable identity across its consolidations", () => {
    const conversation = "cccccccc-0000-4000-8000-000000000001";
    const first = inferenceSessionId("memory_consolidation", conversation);
    expect(first).toBeTruthy();
    // Stable: the same conversation asks for the same host on every job, which
    // is what keeps the prefix above warm between jobs minutes apart.
    expect(inferenceSessionId("memory_consolidation", conversation)).toBe(first);
    // Scoped: never pooled with the roleplay turn, whose prompt shares not one
    // byte of prefix with this one.
    expect(inferenceSessionId("rp_generation", conversation)).not.toBe(first);
    expect(inferenceSessionId("scene_state", conversation)).not.toBe(first);
    // And never one identifier for the whole deployment.
    expect(inferenceSessionId("memory_consolidation", "cccccccc-0000-4000-8000-000000000002")).not.toBe(first);
  });
});
