import type { ResponseLength } from "./types";

/**
 * Response Length.
 *
 * The preference used to be one adjective appended to the system prompt, which
 * is why Concise did almost nothing: the same paragraph was competing with an
 * explicit RULES line telling the writer to vary its length freely, and every
 * mode shared one account-wide `maxTokens`. An adjective loses that argument.
 *
 * So the preference now decides three things together:
 *
 *   1. A concrete written directive — beats, paragraphs and an approximate
 *      word target rather than "prefer a tighter reply".
 *   2. A soft target the directive names, so the writer has a number to aim at
 *      instead of a mood.
 *   3. An output budget: a real per-mode `max_tokens` sent to the provider.
 *
 * The budget is an ENVELOPE, never a target. Every ceiling below sits at
 * roughly four times the tokens the mode's own word target implies, so a reply
 * that lands where it was asked to land finishes naturally and a reply that
 * runs long still has room to close its sentence. Nothing here exists to
 * truncate text — truncation would be a worse product than the bug it fixed.
 *
 * Budgets are derived from the account's configured `maxTokens` rather than
 * hard-coded, so an operator who raises the deployment ceiling raises all
 * three modes proportionally and keeps Natural exactly where it is today.
 */

export type ResponseLengthPlan = {
  length: ResponseLength;
  /** The hard output ceiling sent to the provider for this mode. */
  maxTokens: number;
  /** Approximate words the directive asks for. Soft, and named in the prompt. */
  targetWords: { low: number; high: number } | null;
  /** The block appended to the system prompt, or "" for Natural. */
  instruction: string;
};

/** Never send an envelope so small that an ordinary paragraph cannot finish. */
const floorTokens = 420;
/** Nor one so large that a runaway generation bills for a chapter. */
const ceilingTokens = 6000;

const shape: Record<ResponseLength, { scale: number; words: { low: number; high: number } | null }> = {
  // ~150 words of prose is roughly 200 tokens; 0.45 x 1800 = 810 leaves four
  // times that as headroom, which is an envelope rather than a guillotine.
  concise: { scale: 0.45, words: { low: 90, high: 170 } },
  // Natural is the untouched baseline. Same budget, same prompt, by design:
  // it is the mode every existing conversation is already calibrated to.
  natural: { scale: 1, words: null },
  detailed: { scale: 1.6, words: { low: 320, high: 520 } },
};

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, Math.round(value)));
}

export function responseLengthBudget(length: ResponseLength, baseMaxTokens: number) {
  const base = Number.isFinite(baseMaxTokens) && baseMaxTokens > 0 ? baseMaxTokens : 1800;
  if (length === "natural") return clamp(base, floorTokens, ceilingTokens);
  return clamp(base * shape[length].scale, floorTokens, ceilingTokens);
}

/**
 * The directive.
 *
 * Written as requirements rather than flavour, because the surrounding RULES
 * block already tells the writer to vary its length and a vaguer instruction
 * simply loses to it. The last line of each is the anti-truncation guarantee:
 * the mode governs how much is attempted, never whether a sentence finishes.
 */
function instructionFor(length: ResponseLength, words: { low: number; high: number } | null) {
  if (length === "natural" || !words) return "";
  if (length === "concise") {
    return `\nRESPONSE LENGTH — CONCISE (ACTIVE REQUIREMENT)
This conversation is set to concise replies. Unless the scene genuinely demands more:
- Write ONE to TWO short paragraphs, roughly ${words.low}-${words.high} words in total.
- Carry ONE clear beat: the character's response to what just happened, and one thing that moves.
- Keep action lines tight and dialogue economical. Cut incidental scenery, restated context, and atmospheric expansion that adds no new information.
- Do not summarise, do not list, and do not narrate ahead. Concise means fewer beats, not a compressed report of many.
- Stay vivid, specific and fully in character. A short reply is still a written scene, not a chat message.
This governs how much you attempt, never whether you finish. Complete the beat you started and end on a whole sentence.`;
  }
  return `\nRESPONSE LENGTH — DETAILED (ACTIVE REQUIREMENT)
This conversation is set to detailed replies. When the moment supports it:
- Write THREE to FIVE paragraphs, roughly ${words.low}-${words.high} words in total.
- Let action, dialogue, sensory context, subtext and consequence each do real work.
- Develop the beat rather than announcing it: reactions land, the scene progresses, something is different by the end.
- Do not pad. A brief exchange that has nothing in it stays brief; length must come from substance, never from repetition, restatement or ornament.
This governs how much you attempt, never whether you finish. End on a whole sentence.`;
}

/** The prompt block alone, for callers that build a prompt without a budget. */
export function responseLengthInstruction(length: ResponseLength) {
  return instructionFor(length, shape[length]?.words ?? null);
}

export function responseLengthPlan(length: ResponseLength, baseMaxTokens: number): ResponseLengthPlan {
  const words = shape[length]?.words ?? null;
  return {
    length,
    maxTokens: responseLengthBudget(length, baseMaxTokens),
    targetWords: words,
    instruction: instructionFor(length, words),
  };
}
