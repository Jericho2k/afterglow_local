import { redactProviderSecrets, type ProviderErrorCategory } from "./provider-errors";

/**
 * ONE LINE PER WRITER TURN THAT AN OPERATOR CAN ACTUALLY DEBUG FROM.
 *
 * The report that produced this file is precise and was unanswerable:
 *
 *   "Send usually works. Continue usually works. Regenerate fails extremely
 *    often, sometimes almost every attempt, with 'Something went wrong while
 *    generating the response.'"
 *
 * Nothing in the logs could say what was different about Regenerate, because
 * the three actions were not recorded in a form that could be compared. The
 * timeline (src/lib/request-timing.ts) says where the milliseconds went and is
 * off by default; the provider diagnostic (src/lib/provider-errors.ts) says why
 * one upstream call failed. Neither says what the TURN was: which action, which
 * message it targeted, which variant it was about to write, how many rows it
 * loaded, how the stream ended.
 *
 * So this is the turn's own record. It is deliberately one flat line of
 * identifiers and numbers, because the question it has to answer is asked by
 * grepping a log drain for `action=regenerate` and comparing the failures with
 * the successes beside them.
 *
 * WHAT IT MAY NOT DO, AND THIS IS NOT NEGOTIABLE. No prompt text. No reader
 * message. No memory content. No character definition. No credential. Every
 * field below is an identifier, an enumeration or a count — a conversation id
 * is enough to find the row, and the row is behind row level security. The
 * upstream `detail` is the one free-text field and it is passed through the
 * same redaction the provider log uses.
 */

/** How far a turn got. The failing stage is the first question anybody asks. */
export type GenerationStage =
  | "authorised"
  | "conversation_loaded"
  | "model_resolved"
  | "funding_planned"
  | "target_resolved"
  | "transcript_loaded"
  | "memory_retrieved"
  | "prompt_built"
  | "budget_planned"
  | "provider_requested"
  | "provider_accepted"
  | "first_token"
  | "stream_complete"
  | "persisted"
  | "provenance_recorded";

export type GenerationOutcome = "ok" | "refused" | "failed";

export type GenerationDiagnostic = {
  conversationId: string;
  action: "send" | "regenerate" | "continue";
  outcome: GenerationOutcome;
  /** The last stage that completed. With `outcome`, this IS the failing stage. */
  stage: GenerationStage;
  /** Why it ended this way, in the vocabulary the product reasons in. */
  reason?: GenerationFailureReason;
  /** The provider category, when a provider was involved. */
  category?: ProviderErrorCategory;

  /* ---- what the turn was ---- */
  /** The assistant row a regeneration targeted, or null for send/continue. */
  targetMessageId?: string | null;
  /** How the target was found. `client` means the browser named it. */
  targetSource?: "client" | "latest" | "none";
  /** The variant index this generation claimed. */
  variantIndex?: number | null;
  /** How many variants the target already held. */
  existingVariants?: number | null;
  /** The target's absolute position in the conversation, 1-based. */
  messagePosition?: number | null;
  /** Rows read from `messages` before windowing. */
  transcriptRowsLoaded?: number;
  /** Turns actually sent to the writer after anchoring and budgeting. */
  transcriptMessagesSent?: number;
  /** Turns budgeting had to drop. Non-zero is a quality change worth seeing. */
  transcriptTrimmed?: number;
  /** The conversation's own message count, as the turn understood it. */
  conversationMessages?: number;

  /* ---- the request ---- */
  provider?: string;
  model?: string;
  /** The upstream slug, which is what a provider dashboard is indexed by. */
  upstreamModel?: string;
  /** The host OpenRouter routed to, when it said. */
  upstreamProvider?: string;
  /** Whether a provider-stickiness hint was sent. Never the hint itself. */
  sessionScoped?: boolean;
  reasoning?: "on" | "off" | "unset";
  promptTokensEstimated?: number;
  maxTokens?: number;
  temperature?: number;
  responseLength?: string;
  fundingSource?: string;

  /* ---- how it went ---- */
  status?: number;
  attempt?: number;
  requestId?: string;
  ttftMs?: number | null;
  latencyMs?: number | null;
  /** The stream's own account of how it ended. */
  finishReason?: string | null;
  nativeFinishReason?: string | null;
  /** True when the reply stopped because it ran out of envelope. */
  truncated?: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  /** Whether the upstream sent `[DONE]`, and whether a usage frame arrived. */
  streamDone?: boolean;
  usageSeen?: boolean;
  /** Frames the parser could not read. Non-zero means a parser problem. */
  malformedFrames?: number;
  /** Characters of prose delivered. A length, never the text. */
  replyCharacters?: number;
  /** Whether the empty-reply retry ran, and on which host it was avoided. */
  retried?: boolean;
  /** A trimmed, redacted upstream body. Operator only; never sent to a client. */
  detail?: string;
};

/**
 * The failure vocabulary.
 *
 * `unknown` is deliberately last and deliberately rare: every value above it
 * names something an operator can act on, and a turn logged as `unknown` is a
 * gap in this list rather than an acceptable answer. That is the whole
 * complaint this sprint is answering — "Something went wrong" with nothing
 * behind it is not a diagnosis.
 */
export type GenerationFailureReason =
  | "timeout"
  | "bad_request"
  | "provider_incompatible"
  | "auth"
  | "billing"
  | "rate_limited"
  | "upstream_unavailable"
  | "empty_response"
  | "content_filtered"
  | "stream_parse_failure"
  | "persistence_failure"
  | "variant_conflict"
  | "regenerate_target_missing"
  | "context_exceeded"
  | "model_unavailable"
  | "free_capacity_exhausted"
  | "client_aborted"
  | "unknown";

/**
 * Whether successful turns are logged too.
 *
 * Failures are ALWAYS logged — a failure nobody can see is the bug this file
 * exists to remove. Successes are the comparison set, and one line per reply is
 * a real cost on a busy deployment, so they are opt-in: `CHAT_GENERATION_DIAGNOSTICS=1`
 * for a debugging window, and on by default in development.
 */
export function generationDiagnosticsEnabled() {
  if (process.env.CHAT_GENERATION_DIAGNOSTICS === "1") return true;
  if (process.env.CHAT_GENERATION_DIAGNOSTICS === "0") return false;
  return process.env.NODE_ENV === "development";
}

/** Drops absent fields so a line stays readable, and redacts the one free text. */
function serialise(record: GenerationDiagnostic) {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined);
  const cleaned = Object.fromEntries(entries.map(([key, value]) =>
    key === "detail" && typeof value === "string" ? [key, redactProviderSecrets(value).slice(0, 500)] : [key, value]));
  return redactProviderSecrets(JSON.stringify(cleaned));
}

export function logGeneration(record: GenerationDiagnostic) {
  if (record.outcome === "ok") {
    if (!generationDiagnosticsEnabled()) return;
    console.info("[generation] rp turn", serialise(record));
    return;
  }
  // A refusal is a product answer and a failure is a fault, and an operator
  // scanning for one does not want the other. Both are always written.
  const write = record.outcome === "refused" ? console.warn : console.error;
  write(`[generation] rp turn ${record.outcome}`, serialise(record));
}

/** The reason a `ProviderErrorCategory` maps to. One place, so the two agree. */
export function reasonForCategory(category: ProviderErrorCategory): GenerationFailureReason {
  return category === "unknown" ? "unknown" : category;
}
