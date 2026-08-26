import type { ResponseLength } from "./types";

/**
 * Response Length.
 *
 * The preference used to be one adjective appended to the system prompt, which
 * is why Concise did almost nothing: the same paragraph was competing with an
 * explicit RULES line telling the writer to vary its length freely, and every
 * mode shared one account-wide `maxTokens`. An adjective loses that argument.
 *
 * The first version of this file fixed three of the four things that decide how
 * long a reply is:
 *
 *   1. A concrete written directive — beats, paragraphs and an approximate
 *      word target rather than "prefer a tighter reply".
 *   2. A soft target the directive names, so the writer has a number to aim at
 *      instead of a mood.
 *   3. An output budget: a real per-mode `max_tokens` sent to the provider.
 *
 * It still produced six-paragraph "concise" replies on MiMo, and the reason was
 * the fourth thing, which is not what the instruction SAYS but where it sits
 * and what else the prompt says at the same time:
 *
 *   THE PROMPT CONTRADICTED ITSELF. Two general rules argued directly against
 *   Concise — "let the moment develop through specific action, dialogue,
 *   sensory detail, subtext, and consequence instead of compressing it into a
 *   summary", and "do not force every reply into the same 2-5 paragraph
 *   template". Both are stated as requirements, both are more specific about
 *   what to DO, and both appear in the same block. `lengthAwareWriterRules`
 *   replaces exactly those two with the version that agrees with the chosen
 *   mode, so there is nothing left in the prompt for the writer to obey
 *   instead.
 *
 *   THE DIRECTIVE WAS FAR AWAY. The head of the prompt is stable, which is what
 *   makes it cacheable, which is why a caching model reads it tens of thousands
 *   of tokens before the turn it is answering. `responseLengthReminder` puts one
 *   line at the end of the per-turn continuity block, which under tail placement
 *   is the last thing before the reader's own message.
 *
 *   SOME MODELS SIMPLY WRITE LONG. That is a property of a model, so it is
 *   declared beside the model as `ModelCapabilities.verbosity` rather than
 *   compared by name at the point of use. An expansive writer gets one extra
 *   hard cap in the directive; nothing else about it changes.
 *
 * The budget is an ENVELOPE, never a target. Nothing here exists to truncate
 * text — truncation would be a worse product than the bug it fixed — so every
 * ceiling sits well above what the mode's own word target implies, and every
 * directive ends by saying that the mode governs how much is attempted and
 * never whether a sentence finishes.
 *
 * Budgets are derived from the account's configured `maxTokens` rather than
 * hard-coded, so an operator who raises the deployment ceiling raises all
 * three modes proportionally and keeps Natural exactly where it is today.
 */

/**
 * How much a model writes when nothing stops it.
 *
 * Declared per model in `src/lib/provider.ts`. "expansive" is not a criticism:
 * MiMo's willingness to keep going is most of why it is good at Detailed. It
 * only means the ceiling has to be stated as a limit rather than implied by a
 * target.
 */
export type ModelVerbosity = "normal" | "expansive";

export type ResponseLengthPlan = {
  length: ResponseLength;
  /** The hard output ceiling sent to the provider for this mode. */
  maxTokens: number;
  /** Approximate words the directive asks for. Soft, and named in the prompt. */
  targetWords: { low: number; high: number } | null;
  /** The block appended to the system prompt, or "" for Natural. */
  instruction: string;
  /** The one-line restatement placed last, or "" for Natural. */
  reminder: string;
  /** Which writer this plan was built for. Diagnostics and tests. */
  verbosity: ModelVerbosity;
};

/** Never send an envelope so small that an ordinary paragraph cannot finish. */
const floorTokens = 420;
/** Nor one so large that a runaway generation bills for a chapter. */
const ceilingTokens = 6000;

const shape: Record<ResponseLength, { scale: number; words: { low: number; high: number } | null }> = {
  /*
   * ~170 words of prose is roughly 230 tokens. 0.33 x 1800 = 594 leaves about
   * two and a half times that, which is an envelope rather than a guillotine:
   * a reply that lands where it was asked to land finishes comfortably, and one
   * that overshoots still has room to close its sentence. The previous 0.45
   * (810 tokens, ~600 words) was large enough to hold the six-paragraph reply
   * this mode exists to prevent, so it was quietly permitting the bug.
   */
  concise: { scale: 0.33, words: { low: 90, high: 170 } },
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
 * The two general rules whose wording depends on the mode.
 *
 * Everything else in the RULES block is about craft and is true at every
 * length. These two are about SIZE, and a rule about size that disagrees with
 * the active response length is not a stylistic preference the writer weighs —
 * it is a direct instruction to ignore the setting.
 *
 * Natural returns the original text, byte for byte, which is what keeps this
 * change invisible to every conversation that never touched the preference.
 */
export function lengthAwareWriterRules(length: ResponseLength): string[] {
  const developTheBeat = "Respond to every meaningful part of the user's turn. For a substantial emotional, sexual, conflict, or action beat, let the moment develop through specific action, dialogue, sensory detail, subtext, and consequence instead of compressing it into a summary.";
  const varyLength = "Vary response length, paragraph shape, sentence rhythm, and dialogue/action balance with the scene. A sharp exchange can be short; a major beat can breathe. Do not force every reply into the same 2-5 paragraph template.";
  if (length === "concise") {
    return [
      "Respond to the part of the user's turn that matters most. Choose the single strongest beat and write that one properly; leave the rest for the next reply rather than covering everything at once.",
      "Keep every reply short. Vary rhythm, paragraph shape and the balance of dialogue to action, but not overall size: this conversation is set to concise and a long reply is wrong even when the scene is a big one.",
    ];
  }
  if (length === "detailed") {
    return [
      developTheBeat,
      "Vary paragraph shape, sentence rhythm, and dialogue/action balance with the scene. Length stays substantial throughout: this conversation is set to detailed, so a beat gets room even when it is a quiet one.",
    ];
  }
  return [developTheBeat, varyLength];
}

/**
 * The directive.
 *
 * Written as requirements rather than flavour, because the surrounding RULES
 * block is itself written as requirements. The last line of each is the
 * anti-truncation guarantee: the mode governs how much is attempted, never
 * whether a sentence finishes.
 */
function instructionFor(length: ResponseLength, words: { low: number; high: number } | null, verbosity: ModelVerbosity) {
  if (length === "natural" || !words) return "";
  if (length === "concise") {
    // An expansive writer needs the ceiling stated as a limit rather than
    // implied by a target: "roughly 90-170 words" reads to it as permission
    // to be a little over, and a little over compounds paragraph by paragraph.
    const cap = verbosity === "expansive"
      ? "\n- HARD LIMIT: never write more than two paragraphs, whatever the scene. If more seems necessary, it belongs in your next reply."
      : "";
    return `\nRESPONSE LENGTH — CONCISE (ACTIVE REQUIREMENT)
This conversation is set to concise replies. Unless the scene genuinely demands more:
- Write ONE to TWO short paragraphs, roughly ${words.low}-${words.high} words in total.
- Carry ONE clear beat: the character's response to what just happened, and one thing that moves.
- Keep action lines tight and dialogue economical. Cut incidental scenery, restated context, and atmospheric expansion that adds no new information.
- Do not summarise, do not list, and do not narrate ahead. Concise means fewer beats, not a compressed report of many.
- Stay vivid, specific and fully in character. A short reply is still a written scene, not a chat message.${cap}
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

/**
 * The last line before the turn being answered.
 *
 * Deliberately tiny. It is not a second directive and must never grow into
 * one: it restates the number the directive already gave, in the position where
 * the writer is about to act on it. Measured at 22 tokens for concise and 21
 * for detailed; see tests/response-length.test.ts.
 */
export function responseLengthReminder(length: ResponseLength) {
  const words = shape[length]?.words;
  if (!words) return "";
  if (length === "concise") {
    return `\nReply length for this turn: CONCISE — one to two short paragraphs, about ${words.low}-${words.high} words, one beat. Finish the sentence you are on.`;
  }
  return `\nReply length for this turn: DETAILED — three to five paragraphs, about ${words.low}-${words.high} words. Finish the sentence you are on.`;
}

/** The prompt block alone, for callers that build a prompt without a budget. */
export function responseLengthInstruction(length: ResponseLength, verbosity: ModelVerbosity = "normal") {
  return instructionFor(length, shape[length]?.words ?? null, verbosity);
}

export function responseLengthPlan(length: ResponseLength, baseMaxTokens: number, verbosity: ModelVerbosity = "normal"): ResponseLengthPlan {
  const words = shape[length]?.words ?? null;
  return {
    length,
    maxTokens: responseLengthBudget(length, baseMaxTokens),
    targetWords: words,
    instruction: instructionFor(length, words, verbosity),
    reminder: responseLengthReminder(length),
    verbosity,
  };
}
