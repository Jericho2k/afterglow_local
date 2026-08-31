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
 * THE INVARIANT THIS FILE IS RESPONSIBLE FOR.
 *
 * Every accepted story message must always be EITHER already consolidated into
 * continuity, OR still inside the literal transcript the writer is sent. Never
 * neither. A message that has fallen out of the transcript and has not yet been
 * consolidated is simply gone from the story as far as the writer can tell, and
 * no amount of retrieval quality recovers it.
 *
 * The saving in this file comes from making short messages WAIT before buying
 * their own call, and waiting is exactly what puts a message at risk. So the
 * wait has a ceiling, and the ceiling is derived from the writer's own window
 * rather than picked: a fixed 60 pending messages against a default transcript
 * of 30 left up to 29 accepted turns in neither place.
 *
 * Two thirds of the window, because consolidation is asynchronous. The trigger
 * fires, the call takes seconds, and the story keeps moving while it runs; the
 * remaining third is the headroom that pass needs to land before the oldest
 * pending message reaches the edge.
 *
 * DELIBERATELY NO FIXED FLOOR. An earlier draft read `max(12, window * 0.66)`,
 * to stop a story of one-word turns consolidating every few messages. The
 * property test in tests/continuity-invariant.ts rejected it: `contextMessages`
 * can be set as low as 8, and a floor of 12 against a window of 8 recreates
 * exactly the hole this rail exists to close, just in a narrower configuration.
 * A reader who chooses a tiny transcript window has chosen more frequent
 * consolidation, and the correctness of their story is not negotiable against
 * the cost of it. The `contextMessages` minimum of 8 makes the smallest possible
 * value here 5.
 */
export function maxPendingMessages(contextMessages?: number) {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MAX_PENDING);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const window = Number.isFinite(Number(contextMessages)) && Number(contextMessages) > 0 ? Number(contextMessages) : 30;
  return Math.max(2, Math.floor(window * 0.66));
}

/**
 * The same ceiling, measured in tokens.
 *
 * The transcript window is bounded twice — by row count and by
 * `contextTokenBudget` — and long messages hit the token bound first. A story
 * of 2,000-token replies saturates a 12K budget after six messages, well inside
 * any row-based rail, so the row rail alone would let the seventh fall through
 * the same hole. Same two thirds, same reason.
 */
export function maxPendingTokens(contextTokenBudget?: number) {
  const configured = Number(process.env.MEMORY_CONSOLIDATION_MAX_PENDING_TOKENS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  const budget = Number.isFinite(Number(contextTokenBudget)) && Number(contextTokenBudget) > 0 ? Number(contextTokenBudget) : 12_000;
  // Same reasoning as above: no floor that could exceed the budget it guards.
  // The `contextTokenBudget` minimum of 4,000 makes the smallest value 2,640.
  return Math.max(500, Math.floor(budget * 0.66));
}

export type ConsolidationTrigger = {
  due: boolean;
  reason: "interval_not_reached" | "waiting_for_material" | "material" | "backlog" | "transcript_pressure" | "forced";
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
  /** The writer's transcript window, which is what the backlog rail protects. */
  contextMessages?: number;
  contextTokenBudget?: number;
  force?: boolean;
}): ConsolidationTrigger {
  if (input.delta <= 0) return { due: false, reason: "interval_not_reached" };
  if (input.force) return { due: true, reason: "forced" };

  /*
   * The transcript rails are checked BEFORE the interval gate, not after it.
   *
   * They exist to stop a message falling out of the writer's window while still
   * unconsolidated, and "we have not reached the interval yet" is no answer to
   * that: a reader whose interval is 25 against a window of 30 would otherwise
   * be told to wait past the very edge the rail is guarding. In ordinary use the
   * rails sit far above the interval and never fire first.
   */
  if (input.delta >= maxPendingMessages(input.contextMessages)) return { due: true, reason: "backlog" };
  if (input.pendingTokens >= maxPendingTokens(input.contextTokenBudget)) return { due: true, reason: "transcript_pressure" };

  if (input.delta < input.interval) return { due: false, reason: "interval_not_reached" };
  if (input.pendingTokens >= minBatchTokens()) return { due: true, reason: "material" };
  return { due: false, reason: "waiting_for_material" };
}

export type ConsolidationBatch = {
  /** The messages this call reads, oldest first. Never empty when input is not. */
  messages: Message[];
  /**
   * How many WHOLE rows past `last_consolidated_count` the batch consumed.
   *
   * Zero is legal and means the batch is a chunk of one oversized message that
   * is not finished yet. The position pointer must not move in that case, or
   * the rest of that message is skipped forever; `nextOffset` moves instead.
   */
  size: number;
  /** Estimated transcript tokens in the batch. */
  tokens: number;
  /**
   * Where inside the first unconsolidated message the NEXT call should resume,
   * in characters. Zero once that message has been consumed whole.
   */
  nextOffset: number;
  /** Set when this batch is one chunk of a message too large to read at once. */
  chunk: { messageId: string; from: number; to: number; length: number; final: boolean } | null;
  /** True when unseen material remains after this batch — rows or a message tail. */
  more: boolean;
};

/**
 * How much of the previous chunk is repeated at the start of the next one.
 *
 * A fact that straddles a chunk boundary would otherwise be split across two
 * calls and extracted by neither. The overlap is sent as context and marked as
 * already-read, so it informs the model without inviting it to emit the same
 * memory twice.
 */
export const chunkOverlapCharacters = 600;

/** What a resumed chunk says about the text in front of it. */
export const chunkResumeMarker = "[… continuing a long message; the text above this line was already read in an earlier pass, do not extract it again …]\n\n";

/** What a non-final chunk says about the text after it. */
export const chunkContinuesMarker = "\n\n[… this message continues and will be read in the next pass …]";

/**
 * The next chronological window, bounded in rows and in tokens.
 *
 * `available` must be the messages starting at `last_consolidated_count`, in
 * ascending order — the same read the caller already performs. The batch is a
 * PREFIX of it, which is what guarantees no gap and no overlap between one call
 * and the next.
 *
 * ONE MESSAGE LARGER THAN THE WHOLE WINDOW.
 *
 * This used to clip such a message to the ceiling, mark it abridged, and then
 * advance the position pointer past the WHOLE row. The clip was honest in the
 * prompt and dishonest in effect: the tail was never read, by that call or any
 * later one, and nothing recorded that it had been dropped. Today's 12K-character
 * message limit makes it unreachable, but both ceilings are configurable and the
 * behaviour was wrong at any size.
 *
 * So a message that does not fit is consumed in deterministic sequential chunks
 * instead. `startOffset` is where the last pass stopped; the batch carries the
 * next chunk, with a small marked overlap for continuity, and reports where to
 * resume. The row is only counted as consolidated once its final chunk is read,
 * which is what makes the whole thing restart-safe: a crash mid-message resumes
 * at the last persisted offset rather than skipping to the next row.
 */
export function planConsolidationBatch(
  available: Message[],
  options?: { maxTokens?: number; maxRows?: number; startOffset?: number },
): ConsolidationBatch {
  const tokenCeiling = Math.max(500, options?.maxTokens ?? maxBatchTokens());
  const rowCeiling = Math.max(1, options?.maxRows ?? maxBatchRows());
  const startOffset = Math.max(0, Math.floor(options?.startOffset ?? 0));
  const empty: ConsolidationBatch = { messages: [], size: 0, tokens: 0, nextOffset: 0, chunk: null, more: false };
  if (!available.length) return empty;

  const first = available[0];
  const remaining = first.content.length - startOffset;

  // Mid-message, or a message that cannot fit even from its start.
  if (startOffset > 0 || estimateTokens(first.content) + 8 > tokenCeiling) {
    if (remaining <= 0) {
      // The offset has already consumed the row; treat it as finished so the
      // caller advances past it rather than looping on an empty tail.
      return { messages: [], size: 1, tokens: 0, nextOffset: 0, chunk: null, more: available.length > 1 };
    }
    return chunkOf(first, startOffset, tokenCeiling, available.length > 1);
  }

  const messages: Message[] = [];
  let tokens = 0;
  for (const message of available) {
    if (messages.length >= rowCeiling) break;
    const cost = estimateTokens(message.content) + 8;
    if (messages.length > 0 && tokens + cost > tokenCeiling) break;
    if (messages.length > 0 && cost > tokenCeiling) break; // start the oversized one on its own pass
    messages.push(message);
    tokens += cost;
  }
  return { messages, size: messages.length, tokens, nextOffset: 0, chunk: null, more: available.length > messages.length };
}

/** One bounded slice of an oversized message, with its overlap and markers. */
function chunkOf(message: Message, startOffset: number, tokenCeiling: number, moreRows: boolean): ConsolidationBatch {
  const overlapFrom = Math.max(0, startOffset - chunkOverlapCharacters);
  const overhead = estimateTokens(chunkResumeMarker + chunkContinuesMarker) + (startOffset - overlapFrom) / 4 + 8;
  const bodyCharacters = Math.max(400, Math.floor((tokenCeiling - overhead) * 4));
  const to = Math.min(message.content.length, startOffset + bodyCharacters);
  const final = to >= message.content.length;

  const body = message.content.slice(startOffset, to);
  const prefix = startOffset > overlapFrom ? `${message.content.slice(overlapFrom, startOffset)}\n\n${chunkResumeMarker}` : "";
  const content = `${prefix}${body}${final ? "" : chunkContinuesMarker}`;

  return {
    messages: [{ ...message, content }],
    // The row is only consolidated once its last chunk has been read.
    size: final ? 1 : 0,
    tokens: estimateTokens(content) + 8,
    nextOffset: final ? 0 : to,
    chunk: { messageId: message.id, from: startOffset, to, length: message.content.length, final },
    more: !final || moreRows,
  };
}
