import { describe, expect, it } from "vitest";
import { createWriterStreamParser, streamEnding, terminalEvidence, truncatedByLength } from "@/lib/stream-parse";

/**
 * The end of a reply, against every way a network can deliver it.
 *
 * The reported symptom was "responses frequently end abruptly and feel
 * unfinished", with no error anywhere. A parser that keeps its final
 * unterminated line in a buffer and never looks at it again produces exactly
 * that, silently, and only for the streams that happen to end without a
 * trailing newline — which is why it survived every test written against a
 * well-formed fixture.
 *
 * So these tests do not read a stream. They read the SAME BYTES split at every
 * possible boundary, which is the only honest model of a socket.
 */

const encoder = new TextEncoder();

function frames(...objects: object[]) {
  return objects.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("");
}
function delta(content: string) {
  return { id: "gen-1", model: "z-ai/glm-5.3-flash", provider: "novita", choices: [{ delta: { content } }] };
}

/** Runs the parser over `body` cut into chunks of exactly `size` bytes. */
function parseInChunks(body: string, size: number) {
  const bytes = encoder.encode(body);
  const parser = createWriterStreamParser();
  for (let offset = 0; offset < bytes.length; offset += size) {
    parser.push(bytes.subarray(offset, Math.min(bytes.length, offset + size)));
  }
  parser.end();
  return parser.outcome;
}

/** Every chunk size from one byte to the whole body in one go. */
function everySplit(body: string) {
  const size = encoder.encode(body).length;
  return Array.from({ length: size }, (_, index) => parseInChunks(body, index + 1));
}

describe("the final text survives any chunk boundary", () => {
  const body = `${frames(delta("She turns, "), delta("and the door closes."))}data: [DONE]\n\n`;

  it("reassembles the whole reply however the bytes are cut", () => {
    for (const outcome of everySplit(body)) {
      expect(outcome.text).toBe("She turns, and the door closes.");
      expect(outcome.doneSeen).toBe(true);
      expect(outcome.malformedFrames).toBe(0);
    }
  });

  it("keeps the final delta when the stream ends without a trailing newline", () => {
    // THE BUG. A connection that closes the instant the last frame is written
    // leaves it in the buffer, and the old parser never looked there again.
    const truncatedBody = `${frames(delta("She turns, "))}data: ${JSON.stringify(delta("and the door closes."))}`;
    for (const outcome of everySplit(truncatedBody)) {
      expect(outcome.text).toBe("She turns, and the door closes.");
    }
  });

  it("keeps a [DONE] that arrives without a trailing newline", () => {
    const outcome = parseInChunks(`${frames(delta("Hello."))}data: [DONE]`, 3);
    expect(outcome.text).toBe("Hello.");
    expect(outcome.doneSeen).toBe(true);
  });

  it("does not split a multi-byte character across two chunks", () => {
    const body2 = `${frames(delta("She smiled — 그리고 문이 닫혔다. 🌙"))}data: [DONE]\n\n`;
    for (const outcome of everySplit(body2)) {
      expect(outcome.text).toBe("She smiled — 그리고 문이 닫혔다. 🌙");
    }
  });
});

describe("how the generation ended is recorded", () => {
  it("captures a finish_reason that arrives on the last frame", () => {
    const body = `${frames(delta("A long reply"), { choices: [{ delta: {}, finish_reason: "length", native_finish_reason: "max_tokens" }] })}data: [DONE]\n\n`;
    const outcome = parseInChunks(body, 7);
    expect(outcome.finishReason).toBe("length");
    expect(outcome.nativeFinishReason).toBe("max_tokens");
    expect(truncatedByLength(outcome)).toBe(true);
  });

  it("does not treat a usage-only final frame as the end of the text", () => {
    // Usage arrives on a frame with no choices, and text can still follow it.
    const body = `${frames(
      delta("First half. "),
      { usage: { prompt_tokens: 10, completion_tokens: 4 } },
      delta("Second half."),
    )}data: [DONE]\n\n`;
    const outcome = parseInChunks(body, 5);
    expect(outcome.text).toBe("First half. Second half.");
    expect(outcome.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4 });
  });

  it("keeps usage that arrives after the final text", () => {
    const body = `${frames(delta("Done."), { usage: { completion_tokens: 2 }, choices: [{ delta: {}, finish_reason: "stop" }] })}data: [DONE]\n\n`;
    const outcome = parseInChunks(body, 4);
    expect(outcome.text).toBe("Done.");
    expect(outcome.finishReason).toBe("stop");
    expect(truncatedByLength(outcome)).toBe(false);
  });

  it("reports a mid-stream error rather than an empty reply", () => {
    const body = `data: ${JSON.stringify({ error: { message: "Provider returned error", code: 429 } })}\n\n`;
    const outcome = parseInChunks(body, 6);
    expect(outcome.error).toEqual({ message: "Provider returned error", code: 429 });
    expect(outcome.text).toBe("");
  });

  it("sees reasoning even when no prose follows it", () => {
    const body = `${frames({ choices: [{ delta: { reasoning: "thinking…" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] })}data: [DONE]\n\n`;
    const outcome = parseInChunks(body, 9);
    expect(outcome.reasoningSeen).toBe(true);
    expect(outcome.text).toBe("");
    expect(outcome.finishReason).toBe("length");
  });
});

describe("wire shapes that are legal and were not handled", () => {
  it("accepts `data:` with no space after the colon", () => {
    const outcome = parseInChunks(`data:${JSON.stringify(delta("Tight."))}\n\n`, 4);
    expect(outcome.text).toBe("Tight.");
  });

  it("accepts CRLF terminators", () => {
    const outcome = parseInChunks(`data: ${JSON.stringify(delta("Proxied."))}\r\n\r\n`, 4);
    expect(outcome.text).toBe("Proxied.");
  });

  it("ignores SSE comments and unknown fields without counting them as frames", () => {
    const body = `: OPENROUTER PROCESSING\n\nevent: ping\n\n${frames(delta("Real."))}`;
    const outcome = parseInChunks(body, 5);
    expect(outcome.text).toBe("Real.");
    expect(outcome.frames).toBe(1);
    expect(outcome.malformedFrames).toBe(0);
  });

  it("takes a non-streamed message body as the reply", () => {
    // Some hosts answer a streaming request with one complete frame.
    const outcome = parseInChunks(`data: ${JSON.stringify({ choices: [{ message: { content: "All at once." }, finish_reason: "stop" }] })}\n\n`, 8);
    expect(outcome.text).toBe("All at once.");
    expect(outcome.finishReason).toBe("stop");
  });

  it("counts a malformed frame instead of silently dropping it", () => {
    const outcome = parseInChunks("data: {not json}\n\n", 3);
    expect(outcome.malformedFrames).toBe(1);
    expect(outcome.frames).toBe(0);
  });

  it("carries the upstream identity out of the stream", () => {
    const outcome = parseInChunks(`${frames(delta("Hi."))}data: [DONE]\n\n`, 11);
    expect(outcome.upstreamProvider).toBe("novita");
    expect(outcome.model).toBe("z-ai/glm-5.3-flash");
    expect(outcome.providerRequestId).toBe("gen-1");
  });

  it("starts clean after a reset, so a retry cannot inherit the first attempt", () => {
    const parser = createWriterStreamParser();
    parser.push(encoder.encode(`${frames(delta("First attempt."))}`));
    parser.end();
    expect(parser.outcome.text).toBe("First attempt.");
    parser.reset();
    parser.push(encoder.encode(`${frames(delta("Second attempt."))}`));
    parser.end();
    expect(parser.outcome.text).toBe("Second attempt.");
  });
});


/**
 * DID THE GENERATION END, OR DID THE CONNECTION?
 *
 * The dropped-final-frame fix removed one way a reply could stop mid-thought.
 * The other leaves no trace at all: prose arrives, the transport dies, and
 * nothing in the protocol ever said the generation was over. Stored and
 * announced as an ordinary success, that is indistinguishable from a reply that
 * finished — which is exactly how it stayed invisible.
 *
 * A completion is claimed only on terminal evidence. These are the shapes that
 * carry it, the shapes that do not, and the boundary between them.
 */
describe("how the stream ended", () => {
  const done = "data: [DONE]\n\n";
  const finished = (reason = "stop") => frames({ choices: [{ delta: {}, finish_reason: reason }] });

  it("is complete with text, a finish reason and [DONE]", () => {
    const outcome = parseInChunks(`${frames(delta("A whole reply."))}${finished()}${done}`, 6);
    expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "finish_reason" });
    expect(terminalEvidence(outcome)).toBe("finish_reason");
  });

  it("is complete with a finish reason but no [DONE]", () => {
    // A provider that closes on its last data frame has still said it finished.
    const outcome = parseInChunks(`${frames(delta("A whole reply."))}${finished()}`, 6);
    expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "finish_reason" });
  });

  it("is complete with a native finish reason alone", () => {
    const outcome = parseInChunks(`${frames(delta("A whole reply."), { choices: [{ delta: {}, native_finish_reason: "STOP" }] })}`, 6);
    expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "native_finish_reason" });
  });

  it("is complete with text and [DONE] but no finish reason", () => {
    const outcome = parseInChunks(`${frames(delta("A whole reply."))}${done}`, 6);
    expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "done" });
  });

  it("is INTERRUPTED on an abrupt end of file with neither", () => {
    // THE CASE THIS EXISTS FOR. Real prose, no protocol statement that the
    // generation is over, and — before this — no way to tell it from a success.
    const outcome = parseInChunks(frames(delta("She turns, and then—")), 5);
    expect(outcome.text).toBe("She turns, and then—");
    expect(terminalEvidence(outcome)).toBeNull();
    expect(streamEnding(outcome)).toEqual({ kind: "interrupted", cause: "transport" });
  });

  it("is complete when the unterminated final frame is the one carrying the evidence", () => {
    // The two failure modes compose: a frame with no trailing newline that
    // holds the finish reason must still be read, and must still count.
    const body = `${frames(delta("She turns, "))}data: ${JSON.stringify({ choices: [{ delta: { content: "and the door closes." }, finish_reason: "stop" }] })}`;
    for (const outcome of everySplit(body)) {
      expect(outcome.text).toBe("She turns, and the door closes.");
      expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "finish_reason" });
    }
  });

  it("is complete, and truncated, at the output ceiling", () => {
    // `length` is terminal evidence: the generation ended, deliberately, at a
    // limit we set. It is a complete stream of an incomplete reply, and those
    // are different facts with different remedies.
    const outcome = parseInChunks(`${frames(delta("A reply that ran out of room mid-"))}${finished("length")}${done}`, 7);
    expect(streamEnding(outcome)).toEqual({ kind: "complete", evidence: "finish_reason" });
    expect(truncatedByLength(outcome)).toBe(true);
  });

  it("is INTERRUPTED when an error arrives after partial text", () => {
    // Text existing is not a reason to ignore an upstream saying it failed.
    const body = `${frames(delta("She turns, "), { error: { message: "upstream connection reset", code: 502 } })}`;
    const outcome = parseInChunks(body, 6);
    expect(outcome.text).toBe("She turns, ");
    expect(streamEnding(outcome)).toEqual({ kind: "interrupted", cause: "upstream_error" });
  });

  it("is INTERRUPTED by an error even when a finish reason also arrived", () => {
    const body = `${frames(delta("Partial."), { error: { message: "provider aborted", code: 500 } }, { choices: [{ delta: {}, finish_reason: "stop" }] })}${done}`;
    expect(streamEnding(parseInChunks(body, 9))).toEqual({ kind: "interrupted", cause: "upstream_error" });
  });

  it("is EMPTY rather than interrupted when no prose arrived at all", () => {
    // A stream with nothing in it is the retry path's question, not this one.
    expect(streamEnding(parseInChunks(frames({ choices: [{ delta: { reasoning: "thinking…" } }] }), 5))).toEqual({ kind: "empty" });
    expect(streamEnding(parseInChunks("", 1))).toEqual({ kind: "empty" });
    expect(streamEnding(parseInChunks(`data: ${JSON.stringify({ error: { message: "no endpoints", code: 404 } })}\n\n`, 5))).toEqual({ kind: "empty" });
  });

  it("reaches the same verdict however the bytes are cut", () => {
    for (const [body, expected] of [
      [`${frames(delta("Done."))}${finished()}${done}`, { kind: "complete", evidence: "finish_reason" }],
      [frames(delta("Cut off")), { kind: "interrupted", cause: "transport" }],
    ] as const) {
      for (const outcome of everySplit(body)) expect(streamEnding(outcome)).toEqual(expected);
    }
  });
});
