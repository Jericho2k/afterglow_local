import { consolidationInput, consolidationInstructions } from "@/lib/prompts";
import { commitmentResolutionCandidates } from "@/lib/memory";
import type { LLMMessage } from "@/lib/llm";
import type { Memory, Message } from "@/lib/types";

/**
 * A long story's consolidation jobs, assembled by the REAL prompt builder.
 *
 * Nothing here re-implements how a consolidation request is put together.
 * `consolidationPayload` calls `consolidationInstructions` and
 * `consolidationInput` — the same two functions `maybeConsolidate` calls — and
 * orders the open commitments through `commitmentResolutionCandidates`, which
 * is the same function that decides which commitments the real job may close.
 * A second assembler would be a second thing to keep in step, and the first
 * time the two disagreed the measurement would be the one that lied.
 *
 * WHAT IS SYNTHETIC IS THE STORY'S DYNAMICS, AND IT IS PESSIMISTIC ON PURPOSE.
 * The rolling summary is rewritten in full on every job — which is what really
 * happens, because it is the previous job's output — and the commitment set
 * churns: a new promise every few jobs, an older one resolved. A cacheability
 * figure measured against a prompt whose dynamic half never moved would be
 * measuring nothing.
 */

const lorem = (words: number, seed = 0) =>
  Array.from({ length: words }, (_, index) => `w${(index * 7 + seed) % 89}`).join(" ");

/** A consolidation window: `interval` messages of new transcript. */
export function windowFor(job: number, interval = 10): Message[] {
  return Array.from({ length: interval }, (_, index) => {
    const position = job * interval + index;
    return {
      id: `m${position}`,
      conversationId: "chat",
      role: position % 2 === 0 ? "user" : "assistant",
      content: position % 2 === 0
        ? `Turn ${position}. ${lorem(24, position)}`
        : `Turn ${position}. ${lorem(70, position)}`,
      variants: [], selectedVariant: 0, memoryIds: [], arcIds: [],
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, position)).toISOString(),
    } as Message;
  });
}

/**
 * The rolling summary as it stands before job N.
 *
 * Rewritten every job and growing toward the 1,200-word ceiling the contract
 * states, because that is what the real consolidator produces: a full ledger,
 * re-emitted, not an append.
 */
export function summaryBefore(job: number) {
  if (job === 0) return "";
  const words = Math.min(900, 220 + job * 26);
  return `CURRENT STATE: ${lorem(40, job)}\n\nMAJOR TIMELINE: ${lorem(words, job * 3)}`;
}

function commitment(id: string, kind: Memory["kind"], content: string, created: string, status: Memory["status"] = "active"): Memory {
  return {
    id, characterId: "c", conversationId: "chat", content, kind, importance: 4,
    keywords: [], pinned: false, status, resolution: "", resolvedAt: null,
    lastRecalledAt: null, recallCount: 0, sourceMessageCount: 0, scene: null,
    createdAt: created,
  } as Memory;
}

/**
 * The open commitments before job N.
 *
 * One new promise every third job and one resolution every fifth, so the block
 * is identical between most consecutive jobs and genuinely different between
 * some. That churn is what the cacheability measurement is actually about: a
 * block that never changed would flatter the result, and one that changed every
 * time would make the ordering question moot.
 */
export function commitmentsBefore(job: number) {
  const all: Memory[] = [];
  for (let index = 0; index * 3 <= job; index += 1) {
    const resolved = index > 0 && (job - index * 3) >= 5 && index % 5 === 1;
    all.push(commitment(
      `c${index}`,
      index % 2 === 0 ? "promise" : "open_loop",
      `She said she would ${lorem(9, index)}.`,
      new Date(Date.UTC(2026, 0, 1, index)).toISOString(),
      resolved ? "resolved" : "active",
    ));
  }
  // Through the same selector the real job uses, so the order under test is the
  // order production sends.
  return commitmentResolutionCandidates(all);
}

/** One consolidation request, exactly as `maybeConsolidate` builds it. */
export function consolidationPayload(job: number, interval = 10): LLMMessage[] {
  return [
    { role: "system", content: `You are a precise continuity editor and episodic-memory curator. Output JSON only.\n\n${consolidationInstructions()}` },
    { role: "user", content: consolidationInput(summaryBefore(job), windowFor(job, interval), "You", commitmentsBefore(job)) },
  ];
}
