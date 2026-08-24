import type { Message } from "./types";

// A conservative approximation for English prose and roleplay punctuation.
// The provider reports real usage after each request; this estimate is only used
// to keep the rolling transcript inside the configured prompt budget.
export function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function selectRecentMessages(messages: Message[], maxMessages: number, tokenBudget: number) {
  const candidates = messages.slice(-Math.max(1, maxMessages));
  const selected: Message[] = [];
  let used = 0;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const message = candidates[index];
    const cost = estimateTokens(message.content) + 8;
    // Preserve at least the last exchange even when a single very long message
    // exceeds the estimate; otherwise continuation and regeneration lose the scene.
    if (selected.length >= 2 && used + cost > tokenBudget) break;
    selected.unshift(message);
    used += cost;
  }

  return selected;
}

export function recallText(messages: Message[], fallback = "") {
  const recent = messages.slice(-8).map((message) => `${message.role}: ${message.content}`).join("\n");
  return recent || fallback;
}

/**
 * How many messages the anchor moves in one go.
 *
 * Every step is one cache invalidation, so a larger step means a longer-lived
 * prefix and a slightly wider window; a smaller step means a tighter window
 * and more frequent invalidation. Eight is roughly four exchanges: long enough
 * that a normal session re-anchors a handful of times, small enough that the
 * extra transcript stays inside the growth allowance below.
 */
export const anchorStep = 8;

/** Rows to read so the anchored window always has the messages it may want. */
export function anchoredFetchLimit(maxMessages: number) {
  return Math.max(1, maxMessages) + anchorStep;
}

/**
 * The transcript window, anchored so its prefix stops moving every turn.
 *
 * `selectRecentMessages` above keeps the newest messages that fit the budget.
 * Correct, and quietly expensive: once a long conversation saturates the
 * budget, every turn drops one message from the FRONT of the window, so the
 * first token of the transcript changes on every single request and no
 * provider prompt cache can match past the system prompt. Two consecutive
 * prompts are ~90% identical and ~0% reusable.
 *
 * So the window's start is quantised. `dropped` — how many of the
 * conversation's messages the budget excludes — grows by about one per turn,
 * and rounding it down to a multiple of `anchorStep` makes the start move only
 * once every `anchorStep` messages. In between, the window is append-only:
 * turn N+1's transcript is turn N's transcript plus the new exchange, which is
 * a prefix a provider can actually reuse.
 *
 * THE RESULT IS ALWAYS A SUPERSET OF `selectRecentMessages`. Rounding down can
 * only move the start earlier, never later, so the writer never receives less
 * transcript than it does today — at most `anchorStep - 1` messages more.
 * Caching is bought with a few extra (and, by construction, cached) tokens
 * rather than with continuity.
 *
 * @param available   The newest messages read from the database, oldest first.
 * @param totalMessages How many messages the conversation holds in total. This
 *   is the absolute reference the anchor is quantised against; without it the
 *   anchor would be measured from the end and would slide every turn again.
 */
export function selectAnchoredMessages(
  available: Message[],
  totalMessages: number,
  maxMessages: number,
  tokenBudget: number,
) {
  const baseline = selectRecentMessages(available, maxMessages, tokenBudget);
  const total = Math.max(totalMessages, available.length);
  // Nothing is being dropped, so there is no anchor to place.
  if (baseline.length >= total) return baseline;

  const dropped = total - baseline.length;
  const anchorDropped = Math.floor(dropped / anchorStep) * anchorStep;
  const want = total - anchorDropped;
  // Bounded by what was actually read: the caller fetches
  // `anchoredFetchLimit(maxMessages)` rows, so `want` normally fits.
  return available.slice(-Math.min(want, available.length));
}

/**
 * How much of one turn's message list the next turn reuses unchanged.
 *
 * Used by the caching tests and by nothing in the request path: a number is
 * the only honest way to claim a prefix got more stable, and this is that
 * number, computed from the exact arrays a provider would have received.
 */
export function sharedPrefixRatio(previous: Message[], next: Message[]) {
  if (!previous.length) return next.length ? 0 : 1;
  let shared = 0;
  while (shared < previous.length && shared < next.length && previous[shared].id === next[shared].id
    && previous[shared].content === next[shared].content) shared += 1;
  return shared / previous.length;
}
