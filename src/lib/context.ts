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
 * Every step is one cache invalidation, so this is a straight economic
 * trade and it now has numbers behind it rather than a plausible-sounding
 * guess. Measured through the real prompt builder over a long story
 * (tests/prompt-cacheability.test.ts):
 *
 *   a turn where the anchor HOLDS reuses about 80% of the request
 *   a turn where the anchor MOVES reuses about 46%
 *
 * A step of S messages re-anchors once every S/2 turns, since a turn adds two
 * messages. So a smaller step pays that ~34-point drop more often, while a
 * larger step carries up to S-1 extra messages of transcript in every request —
 * which are, by construction, inside the cached prefix, and therefore billed at
 * the CACHED rate rather than the fresh one.
 *
 * That is the whole calculation, and at GLM 4.7's DeepInfra rates ($0.40/M
 * fresh against $0.08/M cached — a five-to-one ratio) it is not close. The
 * amortised cost of re-anchoring falls as 1/S while the cost of the extra
 * carried transcript rises as S, and the two cross well above eight. Sixteen is
 * deliberately short of the arithmetic optimum: the model assumes
 * average-length replies, and a story of unusually long ones would carry more
 * tokens than the sweep predicts. Half the theoretical gain with half the
 * exposure is the right side to err on.
 *
 * IT COSTS NO CONTINUITY AT ANY VALUE. The anchored window is always a superset
 * of what the budget rule alone would select — rounding down can only move the
 * window's start earlier — so a larger step buys cache with a few extra cached
 * tokens, never with dropped context.
 *
 * `TRANSCRIPT_ANCHOR_STEP` lets an operator retune without a deploy. It is
 * clamped to a sane band: below 2 the anchor moves every turn and the whole
 * mechanism is off, and an unbounded value would let one variable put a very
 * long transcript into every request.
 */
export const defaultAnchorStep = 16;

export function anchorStepFor() {
  const configured = Number(process.env.TRANSCRIPT_ANCHOR_STEP);
  if (!Number.isFinite(configured)) return defaultAnchorStep;
  return Math.min(64, Math.max(2, Math.floor(configured)));
}

/**
 * Retained as a constant for callers that only need the shipped default —
 * chiefly tests asserting on rollover frequency. The request path calls
 * `anchorStepFor()` so an operator override actually takes effect.
 */
export const anchorStep = defaultAnchorStep;

/** Rows to read so the anchored window always has the messages it may want. */
export function anchoredFetchLimit(maxMessages: number, step = anchorStepFor()) {
  return Math.max(1, maxMessages) + step;
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
  step = anchorStepFor(),
) {
  const baseline = selectRecentMessages(available, maxMessages, tokenBudget);
  const total = Math.max(totalMessages, available.length);
  // Nothing is being dropped, so there is no anchor to place.
  if (baseline.length >= total) return baseline;

  const dropped = total - baseline.length;
  const anchorDropped = Math.floor(dropped / step) * step;
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
