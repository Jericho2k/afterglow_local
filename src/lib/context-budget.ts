import { estimateTokens } from "./context";
import type { ModelCapabilities } from "./provider";

/**
 * Making the request fit the model, rather than finding out afterwards.
 *
 * Afterglow budgets the two layers it has always budgeted — the transcript
 * window and the memory archive — and lets the rest grow freely. That is fine
 * while every model is large. Midnight Cherry is not: 32,768 tokens, against a
 * Creation definition and World lore with no ceiling at all. A hundred-thousand
 * character World is about 28,000 tokens on its own, so a perfectly ordinary
 * story stopped being sendable, OpenRouter answered 400, and the reader was
 * told "Something went wrong while generating the response" about a request
 * that never had a chance.
 *
 * This plans the request instead. The order in which room is found matters, and
 * it is deliberately the order that costs the reader least:
 *
 *   1. THE OUTPUT ENVELOPE COMES DOWN FIRST. `max_tokens` is a ceiling, not a
 *      target — a Concise reply asks for ~170 words and is given room for four
 *      times that — so trimming the unused headroom costs nothing at all.
 *   2. THEN THE BUDGETED LAYERS. The transcript window and the memory budget
 *      are budgets; making one smaller is what a budget is for, it is
 *      reversible on the next turn, and the caller records what it did.
 *   3. THE CREATION AND ITS WORLD ARE NEVER SILENTLY CUT. If the static
 *      material alone will not fit, the honest answer is to say so and name the
 *      remedy. Quietly truncating a creator's canon to make a request succeed
 *      would produce a reply that reads fine and is wrong, which is worse than
 *      the error it replaced.
 *
 * A model with no verified `contextTokens` is not constrained, so nothing here
 * changes behaviour for a model whose real limit is unknown.
 */

/** Estimation slack. `estimateTokens` is chars/4, which under-counts prose. */
export const budgetHeadroomRatio = 0.12;
/** Never plan an envelope so small that an ordinary paragraph cannot finish. */
export const minimumOutputTokens = 320;

export type BudgetInput = {
  capabilities: Pick<ModelCapabilities, "contextTokens" | "maxOutputTokens">;
  /** The system prompt as assembled, in full. */
  systemPrompt: string;
  /** The transcript and any control cue, as they will be sent. */
  conversationTexts: string[];
  /** What Response Length asked for. */
  requestedMaxTokens: number;
};

export type BudgetPlan = {
  /** The `max_tokens` to send. Never above what was requested. */
  maxTokens: number;
  promptTokens: number;
  /** Room left for the reply after the prompt and the safety margin. */
  availableForOutput: number;
  /** True when the envelope had to be reduced to fit. */
  constrained: boolean;
  /**
   * True when the prompt does not fit even with the smallest usable envelope.
   * The caller must refuse rather than send: see `contextExceededMessage`.
   */
  overflows: boolean;
  /** How many prompt tokens have to go for the request to become sendable. */
  overflowTokens: number;
};

export function planRequestBudget(input: BudgetInput): BudgetPlan {
  const promptTokens = estimateTokens(input.systemPrompt) + input.conversationTexts.reduce((sum, text) => sum + estimateTokens(text) + 8, 0);
  const ceiling = input.capabilities.maxOutputTokens
    ? Math.min(input.requestedMaxTokens, input.capabilities.maxOutputTokens)
    : input.requestedMaxTokens;

  // Unverified context window: constrain nothing, exactly as before.
  if (!input.capabilities.contextTokens) {
    return { maxTokens: ceiling, promptTokens, availableForOutput: ceiling, constrained: ceiling < input.requestedMaxTokens, overflows: false, overflowTokens: 0 };
  }

  const usable = Math.floor(input.capabilities.contextTokens * (1 - budgetHeadroomRatio));
  const availableForOutput = usable - promptTokens;
  if (availableForOutput < minimumOutputTokens) {
    return {
      maxTokens: minimumOutputTokens,
      promptTokens,
      availableForOutput: Math.max(0, availableForOutput),
      constrained: true,
      overflows: true,
      overflowTokens: minimumOutputTokens - availableForOutput,
    };
  }

  const maxTokens = Math.min(ceiling, availableForOutput);
  return { maxTokens, promptTokens, availableForOutput, constrained: maxTokens < input.requestedMaxTokens, overflows: false, overflowTokens: 0 };
}

/**
 * What a reader is told when their story is larger than their writer.
 *
 * Actionable rather than apologetic: it names the cause, names the remedy, and
 * promises that nothing was lost. `reason` lets the client offer the model
 * picker directly, the same way model retirement already does.
 */
export const contextExceededMessage =
  "This story's world and character material is larger than this model can read in one go. Choose a model with a larger context in chat tools — your story, memories and settings are untouched.";

/**
 * Drops the oldest turns until the request fits, and says how many it dropped.
 *
 * Only ever the FRONT of the transcript, and never the newest exchange: a reply
 * generated without the message it is replying to would be a worse failure than
 * the error this avoids. The Creation, its cast and its World are not touched
 * here at all — if they are what does not fit, the caller refuses instead, and
 * the reader is told which choice will fix it.
 *
 * Every drop is reported so the caller can record it. A window that silently
 * got smaller is a quality change nobody agreed to; a window that got smaller
 * and said so is a measurement.
 */
export function fitConversation<T extends { content: string }>(
  messages: T[],
  input: Omit<BudgetInput, "conversationTexts">,
  keepNewest = 2,
): { messages: T[]; dropped: number; plan: BudgetPlan } {
  let kept = messages;
  let dropped = 0;
  let plan = planRequestBudget({ ...input, conversationTexts: kept.map((message) => message.content) });
  while (plan.overflows && kept.length > keepNewest) {
    kept = kept.slice(1);
    dropped += 1;
    plan = planRequestBudget({ ...input, conversationTexts: kept.map((message) => message.content) });
  }
  return { messages: kept, dropped, plan };
}
