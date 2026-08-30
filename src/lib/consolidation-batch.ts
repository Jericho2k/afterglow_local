import { estimateTokens } from "./context";
import type { Message } from "./types";

/**
 * How much transcript one memory-update call is allowed to read, and when a
 * call is worth making at all.
 *
 * The previous rule was one number: "the next up-to-50 unseen rows, whenever at
 * least `consolidationInterval` of them exist". Both halves of that cost money
 * for reasons unrelated to how much story happened.
 *
 * A CALL HAS A FIXED PRICE BEFORE IT READS ANY STORY. The rolling summary, the
 * open commitments, the schema and the rules are sent every time and are most
 * of a short-message call: production averaged ~8.3K prompt tokens per memory
 * update over thirty days, on windows of ten messages that were often a few
 * hundred tokens of actual transcript. Ten one-line messages do not need their
 * own call; they need to wait for the ninety that follow. `minBatchTokens` is
 * that wait, and it is where the saving on ordinary chat comes from.
 *
 * A WINDOW COUNTED IN ROWS HAS NO CEILING IN TOKENS. Fifty rows of long-form
 * roleplay is a different request from fifty rows of banter — the same recent
 * workload reached ~26.4K tokens per call — and a backlog of them is unbounded.
 * `maxBatchTokens` bounds it in the unit that is actually billed.
 *
 * Both are deliberately bounds rather than a rewrite of what gets read. The
 * batch is still the NEXT unseen messages in chronological order, so nothing is
 * skipped, nothing is read twice, and `last_consolidated_count` still advances
 * by exactly the number of messages the call was given.
 */

/** Transcript tokens that must accumulate before a call is worth its overhead. */
export function minBatchTokens() {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MIN_TOKENS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 3_500;
}

/** The most transcript one call may carry. */
export function maxBatchTokens() {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MAX_TOKENS);
  return Number.isFinite(configured) && configured > 0 ? configured : 24_000;
}

/**
 * The row ceiling.
 *
 * Higher than the old fixed 50 on purpose: with a token ceiling doing the real
 * bounding, a backlog of short messages should drain in FEWER calls than
 * before, not the same number. The token ceiling binds first on anything long.
 */
export function maxBatchRows() {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MAX_ROWS);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 120;
}

/**
 * The most accepted messages that may go unconsolidated while waiting for
 * `minBatchTokens`. A story of one-word turns still gets its memory updated.
 */
export function maxPendingMessages() {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MAX_PENDING);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 60;
}

export type ConsolidationTrigger = {
  due: boolean;
  reason: "interval_not_reached" | "waiting_for_material" | "material" | "backlog" | "forced";
};

/**
 * Whether to spend a call now.
 *
 * `force` (the manual "Refresh now" control and the tests) always runs, as long
 * as there is anything unseen at all — a reader who asks for an update gets one.
 */
export function consolidationTrigger(input: {
  delta: number;
  interval: number;
  pendingTokens: number;
  force?: boolean;
}): ConsolidationTrigger {
  if (input.delta <= 0) return { due: false, reason: "interval_not_reached" };
  if (input.force) return { due: true, reason: "forced" };
  if (input.delta < input.interval) return { due: false, reason: "interval_not_reached" };
  if (input.delta >= maxPendingMessages()) return { due: true, reason: "backlog" };
  if (input.pendingTokens >= minBatchTokens()) return { due: true, reason: "material" };
  return { due: false, reason: "waiting_for_material" };
}

export type ConsolidationBatch = {
  /** The messages this call reads, oldest first. Never empty when input is not. */
  messages: Message[];
  /** How many rows past `last_consolidated_count` the batch consumed. */
  size: number;
  /** Estimated transcript tokens in the batch, after any marked clipping. */
  tokens: number;
  /** True when one message alone exceeded the ceiling and had to be clipped. */
  clipped: boolean;
  /** True when unseen messages remain after this batch. */
  more: boolean;
};

/**
 * The marker a clipped message carries into the prompt.
 *
 * A single message can legitimately be longer than any window a task model can
 * read. Dropping it would skip an accepted turn; passing it whole would either
 * blow the context or, worse, fail every time and wedge the position pointer so
 * the story never consolidates again. So it is clipped and SAYS SO, in the
 * prompt, where the model reading it can account for the gap. Nothing is
 * removed quietly.
 */
export const clipMarker = "\n\n[… this message was abridged for continuity extraction; the full text remains in the story …]";

/** `budget` is the whole per-message cost, so the +8 envelope comes off first. */
function clipToTokens(content: string, budget: number) {
  const characters = Math.max(1, (budget - 8) * 4 - clipMarker.length);
  if (content.length <= characters) return content;
  return `${content.slice(0, characters).trimEnd()}${clipMarker}`;
}

/**
 * The next chronological window, bounded in rows and in tokens.
 *
 * `available` must be the messages starting at `last_consolidated_count`, in
 * ascending order — the same read the caller already performs. The batch is a
 * PREFIX of it, which is what guarantees no gap and no overlap between one call
 * and the next.
 */
export function planConsolidationBatch(available: Message[], options?: { maxTokens?: number; maxRows?: number }): ConsolidationBatch {
  const tokenCeiling = Math.max(500, options?.maxTokens ?? maxBatchTokens());
  const rowCeiling = Math.max(1, options?.maxRows ?? maxBatchRows());
  const messages: Message[] = [];
  let tokens = 0;
  let clipped = false;

  for (const message of available) {
    if (messages.length >= rowCeiling) break;
    const cost = estimateTokens(message.content) + 8;
    if (messages.length === 0 && cost > tokenCeiling) {
      // The window's first message does not fit on its own. Take it anyway,
      // clipped and marked, so the position pointer always advances.
      messages.push({ ...message, content: clipToTokens(message.content, tokenCeiling) });
      tokens = estimateTokens(messages[0].content) + 8;
      clipped = true;
      break;
    }
    if (messages.length > 0 && tokens + cost > tokenCeiling) break;
    messages.push(message);
    tokens += cost;
  }

  return { messages, size: messages.length, tokens, clipped, more: available.length > messages.length };
}
