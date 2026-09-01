/**
 * WHAT A MODEL IS ASKED TO THINK, AND WHAT ITS THINKING IS ALLOWED TO COST.
 *
 * Two facts that used to be one number, and the collapse of them into one
 * number is the production failure this file exists to undo.
 *
 *   THE REQUEST SHAPE. `reasoning: { enabled: false }` is not the only way to
 *   ask a hybrid model to think less, and on some endpoints it is not an
 *   available way at all. Z.AI's GLM 5.3 Flash answers it with a 400 —
 *   "Reasoning is mandatory for this endpoint and cannot be disabled" — so the
 *   deployment's declared intention was rejected on every first attempt and
 *   recovered by dropping the parameter, which took the endpoint's own default:
 *   the MOST reasoning, not the least. The adaptation worked and the outcome
 *   was the opposite of what the catalogue asked for.
 *
 *   THE ENVELOPE. Hidden reasoning tokens are spent from the SAME completion
 *   budget as the prose. `settings.maxTokens = 1800` was being sent as the
 *   provider's total ceiling, so a mandatory reasoning pass and an 1,800-token
 *   Natural reply were competing for the same 1,800 tokens — and the reasoning
 *   won every time: `finish_reason=length`, reasoning tokens only,
 *   `replyCharacters=0`. Not an empty response. An exhausted one.
 *
 * So a reply length and a completion budget are separate numbers here. Response
 * Length keeps owning the first — see src/lib/response-length.ts, whose
 * semantics are untouched — and this owns the headroom that goes ON TOP of it
 * for a model whose hidden tokens come out of the same envelope.
 *
 * IT IS PER MODEL, ON PURPOSE, AND DEFAULTS TO NOTHING. A model that declares
 * no reasoning budget gets `providerMaxTokens === visibleTokens`, which is
 * byte-for-byte the request every model sent before this file existed. Raising
 * every model's ceiling to fix one model's endpoint contract would spend real
 * money on models that never had the problem.
 */

/**
 * OpenRouter's reasoning effort scale, as the adapter sends it.
 *
 * These are the values that go on the wire inside `reasoning: { effort }`, so
 * the union is the schema and not a local nickname for it. "none" is
 * deliberately absent: declining reasoning is `"off"` below, which the adapter
 * renders as `reasoning: { enabled: false }`, and having two spellings of the
 * same refusal is how one of them ends up untested.
 */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

const efforts: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (efforts as readonly string[]).includes(value);
}

/**
 * What a catalogue entry says to ask for when the engine has not asked.
 *
 *   "on"      ask for reasoning and let the endpoint choose how much
 *   "off"     decline it explicitly
 *   an effort ask for reasoning and name how much — the only answer available
 *             on an endpoint that will not accept "off"
 */
export type ReasoningDirective = "on" | "off" | ReasoningEffort;

/**
 * The hidden-token allowance one model's endpoint needs above its visible reply.
 *
 * `headroomTokens` is what a mandatory reasoning pass is expected to spend, and
 * it is added to the visible target rather than taken out of it.
 * `ceilingTokens` is the hard stop that bounds BOTH the first request and the
 * single escalation a retry is allowed, so a model that reasons pathologically
 * cannot turn one reader's turn into unbounded spend.
 */
export type ReasoningBudget = {
  headroomTokens: number;
  ceilingTokens: number;
};

/** One turn's two numbers, kept apart where every caller can see both. */
export type CompletionBudget = {
  /** What Response Length asked the writer to SHOW. Unchanged semantics. */
  visibleTokens: number;
  /** Hidden tokens reserved above it. Zero for every model that declares none. */
  headroomTokens: number;
  /** What goes on the wire as `max_tokens`. */
  providerMaxTokens: number;
  /** The most this model's envelope may ever reach, retry escalation included. */
  ceilingTokens: number;
};

/**
 * The visible reply budget, plus whatever hidden headroom the model declares.
 *
 * A model with no declared budget is returned unchanged and unwidened: the
 * three fields collapse onto the number Response Length produced, which is what
 * keeps this invisible to every writer that never had the problem.
 */
export function completionBudgetFor(visibleTokens: number, budget: ReasoningBudget | null | undefined): CompletionBudget {
  const visible = Math.max(0, Math.round(visibleTokens));
  if (!budget) {
    return { visibleTokens: visible, headroomTokens: 0, providerMaxTokens: visible, ceilingTokens: visible };
  }
  const headroom = Math.max(0, Math.round(budget.headroomTokens));
  // A ceiling below the visible target would truncate the reply the reader
  // asked for, which is a worse failure than the spend it was guarding against.
  const ceiling = Math.max(visible, Math.round(budget.ceilingTokens));
  return {
    visibleTokens: visible,
    headroomTokens: headroom,
    providerMaxTokens: Math.min(ceiling, visible + headroom),
    ceilingTokens: ceiling,
  };
}

/**
 * THE ONE LARGER ENVELOPE A RETRY IS ALLOWED, AND NEVER A SECOND.
 *
 * A generation that ran out of room mid-thought is not made likelier to finish
 * by being given the same room again — that retry is a second wait and a second
 * bill for the identical outcome, which is exactly what the empty-reply path
 * was doing. So the retry raises the envelope by one more headroom's worth,
 * bounded by the model's declared ceiling and by whatever room the context
 * budget actually left.
 *
 * `null` means there is nothing left to raise: no declared headroom, or the
 * ceiling is already reached. The caller then has an honest answer for the
 * reader instead of a third identical attempt.
 *
 * @param sentMaxTokens what the failed attempt actually put on the wire, which
 *   may be lower than `budget.providerMaxTokens` if the context budget cut it.
 * @param roomForOutput the most the request could ask for and still fit.
 */
export function escalatedCompletionBudget(budget: CompletionBudget, sentMaxTokens: number, roomForOutput = Infinity) {
  if (budget.headroomTokens <= 0) return null;
  const ceiling = Math.min(budget.ceilingTokens, Math.floor(roomForOutput));
  const raised = Math.min(ceiling, sentMaxTokens + budget.headroomTokens);
  return raised > sentMaxTokens ? raised : null;
}
