/**
 * READING A WRITER'S STREAM WITHOUT LOSING THE END OF IT.
 *
 * The chat route used to parse OpenRouter's stream inline, and the parse had a
 * hole that only ever showed up as a product complaint rather than as an error:
 *
 *   THE LAST LINE COULD BE DROPPED. The loop split the buffer on "\n" and kept
 *   the final element as the incomplete remainder — correct while the stream is
 *   flowing, and wrong at the end of it. A stream whose final `data:` frame is
 *   not followed by a newline (a connection that closes the instant the last
 *   frame is written, a proxy that drops the terminator, an upstream that ends
 *   on `[DONE]` without one) left that frame sitting in the buffer, unparsed,
 *   forever. If it carried the closing sentence of a reply, the reader saw a
 *   reply that stopped mid-thought — the reported "responses are being cut off"
 *   with no error anywhere to explain it.
 *
 *   NOTHING RECORDED HOW THE GENERATION ENDED. `finish_reason` was read only to
 *   distinguish an empty reply, so a reply that WAS produced and was cut off at
 *   the output ceiling was indistinguishable from one that finished. That is
 *   the difference between "the model had nothing more to say" and "we did not
 *   give it room", and they have opposite fixes.
 *
 * So parsing is here, on its own, with tests that split the same bytes at every
 * boundary. See tests/stream-parse.test.ts.
 *
 * WHAT IT MAY NOT DO. It never logs and never stores prompt text; it returns
 * the assistant's prose to its caller and nothing else leaves it.
 */

/** An error a provider delivered inside the stream rather than as a status. */
export type StreamFailure = { message: string; code?: number };

/** Everything one attempt's stream said about itself. */
export type StreamOutcome = {
  /** The visible prose, exactly as it arrived. */
  text: string;
  /** OpenAI-shaped completion reason: stop, length, content_filter, tool_calls… */
  finishReason: string | null;
  /** The upstream's own reason, when it reports one alongside the normalised one. */
  nativeFinishReason: string | null;
  /** An error delivered as a chunk rather than as an HTTP status. */
  error: StreamFailure | null;
  /** True when any `delta.reasoning` arrived, whether or not prose followed. */
  reasoningSeen: boolean;
  /** True when the upstream sent the `[DONE]` sentinel. */
  doneSeen: boolean;
  /** The final usage object, when the upstream sent one. */
  usage: Record<string, unknown> | null;
  providerRequestId?: string;
  /** The model the upstream says actually answered. */
  model?: string;
  /** The upstream host OpenRouter routed to. */
  upstreamProvider?: string;
  /** How many `data:` frames were understood. Diagnostics only. */
  frames: number;
  /** Frames that were not valid JSON. A non-zero count is a parser signal. */
  malformedFrames: number;
};

export function emptyOutcome(): StreamOutcome {
  return {
    text: "", finishReason: null, nativeFinishReason: null, error: null,
    reasoningSeen: false, doneSeen: false, usage: null,
    frames: 0, malformedFrames: 0,
  };
}

/**
 * Whether a completion ended because it ran out of room rather than because it
 * had finished. Both spellings appear in the wild.
 */
export function truncatedByLength(outcome: Pick<StreamOutcome, "finishReason" | "nativeFinishReason">) {
  const reasons = [outcome.finishReason, outcome.nativeFinishReason].filter(Boolean).map((value) => String(value).toLowerCase());
  return reasons.some((reason) => reason === "length" || reason === "max_tokens" || reason === "max_output_tokens");
}

/**
 * HOW THE STREAM ENDED, AND WHETHER ANYTHING ACTUALLY SAID SO.
 *
 * Fixing the dropped final frame removed one way a reply could stop mid-thought.
 * It did not remove the other one, which leaves no trace at all: prose arrives,
 * the transport dies, and there is no `finish_reason`, no `native_finish_reason`
 * and no `[DONE]`. Every byte that arrived is real and worth keeping, and the
 * reply is still unfinished — but with nothing to distinguish it from a
 * generation that ended on purpose, it was stored, announced and logged as an
 * ordinary success. The reader saw a sentence stop halfway and no explanation
 * existed anywhere.
 *
 * So "the stream ended" and "the generation completed" are separated. A
 * completion is only claimed on TERMINAL EVIDENCE — something in the protocol
 * that states the generation is over:
 *
 *   finish_reason         the OpenAI-shaped reason, including `length`
 *   native_finish_reason  the upstream's own, when it reports one
 *   [DONE]                the SSE sentinel
 *
 * Anything else with prose in it is INTERRUPTED. That is not a failure of the
 * whole turn — the text is kept, stored and shown, and the tokens were really
 * produced and are really accounted for — but it is not a success either, and
 * calling it one is what made this invisible.
 *
 * An error frame that arrives AFTER prose is the same shape of problem with a
 * known cause, so it is reported as an interruption with that cause rather than
 * being ignored because text happened to exist.
 */
export type StreamEnding =
  | { kind: "complete"; evidence: "finish_reason" | "native_finish_reason" | "done" }
  | { kind: "empty" }
  | { kind: "interrupted"; cause: "transport" | "upstream_error" };

/** What in the protocol, if anything, said the generation was over. */
export function terminalEvidence(outcome: Pick<StreamOutcome, "finishReason" | "nativeFinishReason" | "doneSeen">) {
  if (outcome.finishReason) return "finish_reason" as const;
  if (outcome.nativeFinishReason) return "native_finish_reason" as const;
  if (outcome.doneSeen) return "done" as const;
  return null;
}

export function streamEnding(outcome: StreamOutcome): StreamEnding {
  // No prose at all is a different question with a different answer — the
  // caller retries it, and `error`/`finish_reason` explain it. See the chat
  // route's empty-reply path.
  if (!outcome.text.trim()) return { kind: "empty" };
  // An upstream that reported a fault mid-stream did not finish, whatever else
  // it sent afterwards.
  if (outcome.error) return { kind: "interrupted", cause: "upstream_error" };
  const evidence = terminalEvidence(outcome);
  return evidence ? { kind: "complete", evidence } : { kind: "interrupted", cause: "transport" };
}

export type WriterStreamParser = {
  /** Feed one network chunk. Boundaries are arbitrary and may split anything. */
  push: (chunk: Uint8Array) => void;
  /** No more bytes are coming. Flushes the decoder AND the buffered final line. */
  end: () => void;
  /** Forget everything, for a retry on a second stream. */
  reset: () => void;
  readonly outcome: StreamOutcome;
};

/**
 * @param onDelta Called with each fragment of visible prose, in order. The
 *   caller streams these to the reader; the accumulated text is also kept in
 *   `outcome.text` so a caller never has to reassemble it.
 */
export function createWriterStreamParser(onDelta: (delta: string) => void = () => {}): WriterStreamParser {
  let decoder = new TextDecoder();
  let buffer = "";
  let outcome = emptyOutcome();

  /**
   * One `data:` payload.
   *
   * The SSE field separator is a colon and the single space after it is
   * OPTIONAL — `data:{…}` is as valid as `data: {…}`. Matching only the spaced
   * form silently discards every frame from an upstream that omits it, which
   * would present as an empty reply rather than as a parse failure.
   */
  const consumePayload = (payload: string) => {
    if (!payload) return;
    if (payload === "[DONE]") { outcome.doneSeen = true; return; }
    let data: Record<string, unknown>;
    try { data = JSON.parse(payload) as Record<string, unknown>; }
    catch { outcome.malformedFrames += 1; return; }
    outcome.frames += 1;

    if (typeof data.id === "string") outcome.providerRequestId = data.id;
    if (typeof data.model === "string") outcome.model = data.model;
    if (typeof data.provider === "string") outcome.upstreamProvider = data.provider;

    // An upstream failure can arrive as a chunk rather than as a status.
    // Recording it is what turns "empty" into a reason.
    const error = data.error as { message?: unknown; code?: unknown } | undefined;
    if (error && typeof error === "object") {
      outcome.error = {
        message: typeof error.message === "string" ? error.message.slice(0, 500) : "upstream reported an error mid-stream",
        code: typeof error.code === "number" ? error.code : undefined,
      };
    }

    const choice = (data.choices as Array<Record<string, unknown>> | undefined)?.[0];
    if (choice) {
      if (typeof choice.finish_reason === "string" && choice.finish_reason) outcome.finishReason = choice.finish_reason;
      if (typeof choice.native_finish_reason === "string" && choice.native_finish_reason) outcome.nativeFinishReason = choice.native_finish_reason;
      const delta = choice.delta as Record<string, unknown> | undefined;
      const message = choice.message as Record<string, unknown> | undefined;
      if (typeof delta?.reasoning === "string" && delta.reasoning) outcome.reasoningSeen = true;
      if (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length) outcome.reasoningSeen = true;
      /*
       * Streaming sends `delta.content`; a provider that answers a streaming
       * request with one non-streamed frame sends `message.content`. Both are
       * the reply, and dropping the second is how a whole generation could
       * arrive and be reported as empty.
       */
      const text = typeof delta?.content === "string" ? delta.content
        : typeof message?.content === "string" ? message.content
        : "";
      if (text) { outcome.text += text; onDelta(text); }
    }

    // Usage arrives last and often on a frame with no choices at all. It must
    // never be treated as an end-of-stream signal: text can still follow it.
    if (data.usage && typeof data.usage === "object") outcome.usage = data.usage as Record<string, unknown>;
  };

  /** One complete line, with its SSE field name still attached. */
  const consumeLine = (rawLine: string) => {
    // "\r\n" terminators are legal and common behind proxies.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) return;
    // An SSE comment. OpenRouter sends `: OPENROUTER PROCESSING` as a keepalive.
    if (line.startsWith(":")) return;
    if (!line.startsWith("data:")) return;
    consumePayload(line.slice(5).trim());
  };

  return {
    push(chunk: Uint8Array) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    },
    end() {
      /*
       * THE FIX THIS FILE EXISTS FOR.
       *
       * Flush the decoder — a multi-byte character split across the last two
       * chunks completes here — and then parse whatever is left in the buffer
       * as a final line. A stream whose last frame has no trailing newline is
       * common enough at a connection close that assuming one loses real text.
       */
      buffer += decoder.decode();
      const remainder = buffer;
      buffer = "";
      if (remainder.trim()) consumeLine(remainder);
    },
    reset() {
      decoder = new TextDecoder();
      buffer = "";
      outcome = emptyOutcome();
    },
    get outcome() { return outcome; },
  };
}
