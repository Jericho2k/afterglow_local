/**
 * What a model failure is, and who is allowed to read it.
 *
 * A provider failure has two audiences with opposite needs. The operator needs
 * the status, the routing metadata, the upstream host and the raw body. The
 * reader needs one calm sentence and their turn back. Before this file the
 * product had exactly one representation — the upstream string — and it went
 * to both, which is how "OpenRouter request failed (429): {…provider JSON…}"
 * came to appear inside a roleplay.
 *
 * So a failure is a `ProviderError`: a category, a public sentence chosen from
 * that category, and a `diagnostic` bag that never leaves the server. The
 * category is also what decides whether retrying is sane, so classification
 * happens once and both the retry policy and the message read the same answer.
 */

export type ProviderErrorCategory =
  /** Upstream is busy or rate limited. Another provider for the same model may not be. */
  | "rate_limited"
  /** A route, deployment or gateway is temporarily down. */
  | "upstream_unavailable"
  /** The request was accepted but produced no text. */
  | "empty_response"
  /** The provider's safety layer refused. Retrying produces the same refusal. */
  | "content_filtered"
  /** The deployment's credentials are wrong. Nobody's turn will fix this. */
  | "auth"
  /** Credit, quota or payment. Also not fixed by retrying. */
  | "billing"
  /** Afterglow sent something the provider rejected. A bug, not a blip. */
  | "bad_request"
  /** The request was cancelled or timed out before completion. */
  | "timeout"
  | "unknown";

/** What a reader is told. Deliberately short, and never names infrastructure. */
const publicMessages: Record<ProviderErrorCategory, string> = {
  rate_limited: "The model is temporarily busy. Please try again in a moment.",
  upstream_unavailable: "The model is temporarily unavailable. Please try again in a moment.",
  empty_response: "The model did not return a reply. Please try again.",
  content_filtered: "This model declined to continue this scene. Try rephrasing, or choose a different model in chat tools.",
  auth: "Something went wrong while generating the response. Please try again.",
  billing: "Something went wrong while generating the response. Please try again.",
  bad_request: "Something went wrong while generating the response. Please try again.",
  timeout: "That reply took too long to arrive. Please try again.",
  unknown: "Something went wrong while generating the response. Please try again.",
};

/** Which categories are worth another attempt against the same model. */
const retryable: Record<ProviderErrorCategory, boolean> = {
  rate_limited: true,
  upstream_unavailable: true,
  empty_response: true,
  // A refusal is a decision, not a blip. Asking the same model the same
  // question again produces the same answer and costs the reader another wait.
  content_filtered: false,
  timeout: false,
  auth: false,
  billing: false,
  bad_request: false,
  unknown: false,
};

export type ProviderDiagnostic = {
  provider?: string;
  model?: string;
  actualModel?: string;
  upstreamProvider?: string;
  status?: number;
  requestId?: string;
  conversationId?: string;
  attempt?: number;
  latencyMs?: number;
  /** A trimmed upstream body. Internal only, and never returned to a client. */
  detail?: string;
};

/** Defensive log redaction for provider bodies and accidentally stringified headers. */
export function redactProviderSecrets(value: string) {
  return value
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[^\s"',}]+/gi, "$1[REDACTED]")
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[REDACTED_OPENROUTER_KEY]");
}

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly diagnostic: ProviderDiagnostic;

  constructor(category: ProviderErrorCategory, diagnostic: ProviderDiagnostic = {}) {
    // `message` is the public sentence, so that the one thing every careless
    // `error.message` in the codebase reaches is already safe. The upstream
    // text lives in `diagnostic.detail`, which no response serialiser touches.
    super(publicMessages[category]);
    this.name = "ProviderError";
    this.category = category;
    this.diagnostic = diagnostic;
  }

  get retryable() {
    return retryable[this.category];
  }

  /** The HTTP status Afterglow answers with. Not the upstream's. */
  get httpStatus() {
    if (this.category === "rate_limited") return 429;
    if (this.category === "timeout") return 504;
    // The request was understood and answered; the answer was a refusal.
    if (this.category === "content_filtered") return 422;
    return 502;
  }

  withDiagnostic(extra: ProviderDiagnostic) {
    return new ProviderError(this.category, { ...this.diagnostic, ...extra });
  }
}

/** The sentence a reader sees for any failure, provider-shaped or not. */
export function publicErrorMessage(error: unknown) {
  if (error instanceof ProviderError) return error.message;
  return publicMessages.unknown;
}

export function publicErrorStatus(error: unknown) {
  return error instanceof ProviderError ? error.httpStatus : 502;
}

/**
 * An upstream HTTP failure, classified.
 *
 * The status is the primary signal; the body is consulted only to tell a
 * temporarily-unroutable provider apart from a genuinely missing model, since
 * both arrive as 404.
 */
export function classifyProviderFailure(status: number, body: string): ProviderErrorCategory {
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "billing";
  if (status === 404) {
    return /provider returned error|deployment .*doesn.t exist|isn.t accessible|no (?:allowed |endpoints|providers)/i.test(body)
      ? "upstream_unavailable"
      : "bad_request";
  }
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500) return "upstream_unavailable";
  return "unknown";
}

/**
 * A 400 THAT IS ABOUT ONE HOST RATHER THAN ABOUT THE REQUEST.
 *
 * `bad_request` is not retryable and must stay that way: Afterglow sending
 * something malformed is a bug, and asking three times does not fix a bug, it
 * only makes the reader wait three times as long to be told nothing.
 *
 * But OpenRouter routes ONE model across many upstreams, and those upstreams do
 * not accept the same request. An endpoint that does not implement `reasoning`,
 * or rejects a field its neighbour ignores, answers 400 for a request that is
 * perfectly valid at the host next to it. Treating that as "Afterglow sent
 * something malformed" throws away every other host serving the model, which is
 * a self-inflicted outage.
 *
 * The two are told apart by WHO REJECTED IT. OpenRouter's own validation
 * failures are its own; a rejection relayed from an upstream carries that
 * upstream's identity in the body (`provider_name`, or a "Provider X returned
 * error" line). Only the relayed kind, and only when it also reads as a
 * capability or parameter complaint, is worth trying somewhere else — and even
 * then it is retried against a DIFFERENT provider for the SAME model, never
 * with a different model and never against the host that just refused.
 *
 * Deliberately narrow. A relayed 400 that does not read as a parameter problem
 * — a content-policy refusal, a malformed message array — stays exactly as
 * non-retryable as it is today.
 */
const upstreamRelay = /provider_name|provider returned error|"provider"\s*:|upstream error/i;
const capabilityComplaint = /\bnot support|unsupported|unrecognized|unrecognised|unknown (?:field|parameter|argument|option)|invalid (?:parameter|argument|field|request format)|does not accept|extra inputs are not permitted|no such parameter|is not allowed|not implemented/i;

export function providerSpecificRejection(status: number, body: string) {
  if (status !== 400 && status !== 422 && status !== 404) return false;
  if (!body) return false;
  return upstreamRelay.test(body) && capabilityComplaint.test(body);
}

/**
 * The operator's copy.
 *
 * Structured, one line, and the only place upstream text is written down. It
 * deliberately records identifiers rather than content: a conversation id is
 * enough to find the row, and the prompt itself is never logged.
 */
export function logProviderDiagnostic(context: string, error: unknown) {
  if (error instanceof ProviderError) {
    const diagnostic = {
      ...error.diagnostic,
      ...(error.diagnostic.detail ? { detail: redactProviderSecrets(error.diagnostic.detail) } : {}),
    };
    console.error(`[provider] ${context}`, redactProviderSecrets(JSON.stringify({ category: error.category, ...diagnostic })));
    return;
  }
  console.error(`[provider] ${context}`, redactProviderSecrets(error instanceof Error ? error.message : String(error)));
}
