import { afterEach, describe, expect, it, vi } from "vitest";
import { completionWithUsage } from "@/lib/llm";
import { ProviderError, logProviderDiagnostic } from "@/lib/provider-errors";

/**
 * WHY WAS IT EMPTY? THE ADAPTER USED TO THROW THAT QUESTION AWAY.
 *
 * `empty_response` was raised carrying a request id and nothing else, and the
 * whole response body — the serving host, the finish reason, the token counts,
 * whether the model had produced reasoning instead of content — was discarded
 * on the way out. A run of background failures in production therefore said
 * nothing about its own cause, which means the cause could not be found from
 * the logs, which means it could not be found.
 *
 * THE CONSTRAINT IS AS IMPORTANT AS THE EVIDENCE. The answer to "why was this
 * empty" frequently lives inside a model's reasoning text, and that is the last
 * thing that may be written to a log — it is derived from a reader's private
 * transcript. So every field is a number, a boolean or an enum, and this suite
 * asserts that as hard as it asserts the diagnosis.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ENABLE_OPENROUTER;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
});

function enable() {
  process.env.ENABLE_OPENROUTER = "true";
  process.env.OPENROUTER_API_KEY = "or-test-secret";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
}

function answerWith(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
}

async function failure(options: Record<string, unknown> = {}) {
  const error = await completionWithUsage(
    { providerId: "openrouter", modelId: "deepseek-v4-flash-0731" },
    [{ role: "user", content: "extract" }],
    { json: true, maxTokens: 3600, modelId: "deepseek-v4-flash-0731", ...options },
  ).catch((caught) => caught as ProviderError);
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

/**
 * THE SHAPE THE 0731 FAILURE IS HYPOTHESISED TO HAVE.
 *
 * Reasoning-capable model, no `reasoning` key sent, a small envelope: the model
 * thinks, the budget runs out, `finish_reason` is "length" and `content` is
 * null with the text in `message.reasoning`. This fixture is what the adapter
 * now has to be able to describe — and, once deployed, what the log line will
 * either confirm or refute against the real host.
 */
const reasoningExhausted = {
  id: "gen-0731",
  model: "deepseek/deepseek-v4-flash-0731",
  provider: "Relace",
  choices: [{
    finish_reason: "length",
    native_finish_reason: "max_tokens",
    message: { content: null, reasoning: "The user wants a summary. Let me consider the boat promise…", reasoning_details: [{ type: "reasoning.text" }] },
  }],
  usage: { prompt_tokens: 1800, completion_tokens: 3600, completion_tokens_details: { reasoning_tokens: 3600 } },
};

describe("what an empty generation now records", () => {
  it("captures the host, the finish reason and the token split", async () => {
    enable();
    answerWith(reasoningExhausted);
    const error = await failure({ thinking: "off" });

    expect(error.diagnostic.upstreamProvider).toBe("Relace");
    expect(error.diagnostic.actualModel).toBe("deepseek/deepseek-v4-flash-0731");
    expect(error.diagnostic.requestId).toBe("gen-0731");
    expect(error.diagnostic.emptyResponse).toMatchObject({
      contentState: "null",
      finishReason: "length",
      nativeFinishReason: "max_tokens",
      promptTokens: 1800,
      completionTokens: 3600,
      reasoningTokens: 3600,
      hasReasoning: true,
      hasReasoningDetails: true,
      requestedReasoningOff: true,
      choices: 1,
    });
  });

  it("calls an exhausted envelope by its own name rather than an empty one", async () => {
    /*
     * Two failures used to wear one name. A host that produced nothing and an
     * envelope spent entirely on hidden thinking have different causes and
     * different remedies — retrying the first is sane, retrying the second
     * unchanged reproduces it exactly and bills for the reasoning again.
     */
    enable();
    answerWith(reasoningExhausted);
    expect((await failure()).category).toBe("reasoning_budget_exhausted");
  });

  it("still calls a genuinely silent host an empty response", async () => {
    enable();
    answerWith({
      id: "gen-silent", model: "m", provider: "DeepInfra",
      choices: [{ finish_reason: "stop", message: { content: null } }],
      usage: { prompt_tokens: 900, completion_tokens: 0 },
    });
    const error = await failure();
    expect(error.category).toBe("empty_response");
    expect(error.diagnostic.emptyResponse).toMatchObject({
      contentState: "null", finishReason: "stop", completionTokens: 0,
      hasReasoning: false, hasReasoningDetails: false, choices: 1,
    });
  });

  it("tells the four ways a reply can be empty apart", async () => {
    enable();
    // They are four different bugs. A missing key is a response shape nobody
    // expected; a null is a model that produced nothing; an empty string is a
    // model that produced nothing and said so; a non-string is an adapter
    // reading the wrong field.
    answerWith({ id: "a", choices: [{ message: {} }] });
    expect((await failure()).diagnostic.emptyResponse?.contentState).toBe("missing");

    answerWith({ id: "b", choices: [{ message: { content: null } }] });
    expect((await failure()).diagnostic.emptyResponse?.contentState).toBe("null");

    answerWith({ id: "c", choices: [{ message: { content: "   " } }] });
    expect((await failure()).diagnostic.emptyResponse?.contentState).toBe("empty_string");

    answerWith({ id: "d", choices: [{ message: { content: { text: "oops" } } }] });
    expect((await failure()).diagnostic.emptyResponse?.contentState).toBe("non_string");
  });

  it("counts zero choices as its own answer rather than as an empty one", async () => {
    enable();
    answerWith({ id: "e", provider: "SomeHost", choices: [] });
    expect((await failure()).diagnostic.emptyResponse).toMatchObject({ choices: 0, contentState: "missing" });
  });

  it("treats whitespace as empty, because a parser will", async () => {
    // `"\n"` is a string, so it used to sail through the type check and fail at
    // `JSON.parse` instead — one failure reported as a different one, two
    // layers away from where it happened.
    enable();
    answerWith({ id: "f", choices: [{ message: { content: "\n\n" } }] });
    expect((await failure()).category).toBe("empty_response");
  });
});

describe("what an empty generation must never record", () => {
  it("carries no reasoning text, no content and no prompt", async () => {
    enable();
    answerWith(reasoningExhausted);
    const error = await failure();
    const serialised = JSON.stringify(error.diagnostic);
    expect(serialised).not.toContain("The user wants a summary");
    expect(serialised).not.toContain("boat promise");
    expect(serialised).not.toContain("extract");
    // Presence is the entire signal, and a boolean carries it completely.
    expect(error.diagnostic.emptyResponse?.hasReasoning).toBe(true);
  });

  it("logs the evidence and none of the text", async () => {
    enable();
    answerWith(reasoningExhausted);
    const error = await failure();
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });

    logProviderDiagnostic("memory consolidation failed", error);

    const line = logged.join("\n");
    // The diagnosis is all there…
    expect(line).toContain("reasoning_budget_exhausted");
    expect(line).toContain("Relace");
    expect(line).toContain("\"reasoningTokens\":3600");
    expect(line).toContain("\"finishReason\":\"length\"");
    // …and not one word of what the model was thinking about.
    expect(line).not.toContain("The user wants a summary");
    expect(line).not.toContain("or-test-secret");
  });
});
