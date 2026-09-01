import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completionBudgetFor, escalatedCompletionBudget } from "@/lib/reasoning";
import { emptyOutcome, reasoningBudgetExhausted, reasoningTokensIn, type StreamOutcome } from "@/lib/stream-parse";
import { ProviderError, publicErrorMessage } from "@/lib/provider-errors";
import { defaultReasoningFor, reasoningBudgetFor, reasoningIsMandatoryFor } from "@/lib/provider";

/**
 * THE GENERATION THAT THOUGHT ITSELF TO DEATH.
 *
 * Production logs named this one exactly, and every claim below is one line of
 * that trace:
 *
 *   1. Afterglow sent `reasoning: { enabled: false }`, because the catalogue
 *      said GLM 5.3 Flash must not reason.
 *   2. Z.AI answered 400: "Reasoning is mandatory for this endpoint and cannot
 *      be disabled."
 *   3. The adapter dropped the parameter and asked again — which takes the
 *      ENDPOINT'S default, the MOST reasoning, the opposite of the intention,
 *      after two requests and a reader's wait.
 *   4. The generation ended `finish_reason=length`,
 *      `native_finish_reason=length`, reasoning tokens only,
 *      `replyCharacters=0`.
 *   5. `settings.maxTokens` was 1800 — and that 1800 was the TOTAL completion
 *      budget, so an 1,800-token Natural reply and a mandatory reasoning pass
 *      were competing for the same tokens.
 *
 * Two bugs wearing one symptom. The request was invalid on every first attempt,
 * and the envelope could not have held an answer even when it was valid. Both
 * are fixed here, and neither fix is allowed to widen any other model's
 * request: the last suite in this file is the one that keeps that honest.
 */

/* ------------------------------------------------------------------ */
/* 1. THE REQUEST IS VALID THE FIRST TIME                              */
/* ------------------------------------------------------------------ */

describe("GLM 5.3 Flash never asks for reasoning to be disabled", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("declares an effort, not a refusal", () => {
    /*
     * "off" was not a setting on this endpoint. It was a rejection followed by
     * a fallback to the endpoint's own maximum, which is why the fix is not a
     * better retry — it is a first request the endpoint accepts.
     */
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("low");
    expect(defaultReasoningFor("glm-5.3-flash")).not.toBe("off");
    expect(reasoningIsMandatoryFor("glm-5.3-flash")).toBe(true);
  });

  it("does not let a deployment-wide off switch rebuild the 400", () => {
    /*
     * `RP_REASONING=off` is an operator saying "spend nothing on thinking". It
     * is not an operator asking to send a request whose known answer is a 400
     * and whose known recovery is MORE reasoning than the default. On every
     * endpoint that will take the refusal it still applies exactly as before.
     */
    vi.stubEnv("RP_REASONING", "off");
    expect(defaultReasoningFor("glm-5.3-flash")).toBe("low");
    expect(defaultReasoningFor("qwen3.8-flash")).toBe("off");
    expect(defaultReasoningFor("glm-4.7")).toBe("off");
  });

  it("keeps the escape hatch that removes the key entirely", () => {
    // Silence is valid on a mandatory endpoint — it takes the endpoint's own
    // default rather than contradicting it — so `auto` stays a real revert.
    vi.stubEnv("RP_REASONING", "auto");
    expect(defaultReasoningFor("glm-5.3-flash")).toBe(null);
  });
});

/* ------------------------------------------------------------------ */
/* 2. THE REPLY BUDGET AND THE COMPLETION BUDGET ARE TWO NUMBERS       */
/* ------------------------------------------------------------------ */

describe("hidden reasoning gets its own room instead of taking the reply's", () => {
  const glm = reasoningBudgetFor("glm-5.3-flash")!;

  it("declares a headroom and a hard ceiling for the model that needs one", () => {
    expect(glm.headroomTokens).toBeGreaterThan(0);
    // Read off the failure: a full 1,800-token envelope was consumed by one
    // unbounded reasoning pass, so the allowance has to be of that order.
    expect(glm.headroomTokens).toBeGreaterThanOrEqual(1_000);
    expect(glm.ceilingTokens).toBeGreaterThan(glm.headroomTokens);
  });

  it("adds headroom above the visible target rather than inside it", () => {
    const natural = completionBudgetFor(1_800, glm);
    // The visible half is untouched: Response Length still means what it meant.
    expect(natural.visibleTokens).toBe(1_800);
    expect(natural.providerMaxTokens).toBe(1_800 + glm.headroomTokens);
    expect(natural.providerMaxTokens).toBeGreaterThan(natural.visibleTokens);
  });

  it("keeps the three response lengths in their existing order", () => {
    // Concise 0.33 x 1800, Natural 1800, Detailed 1.6 x 1800 — the modes still
    // differ from each other; they simply stop competing with the thinking.
    const budgets = [594, 1_800, 2_880].map((visible) => completionBudgetFor(visible, glm));
    expect(budgets[0].providerMaxTokens).toBeLessThan(budgets[1].providerMaxTokens);
    expect(budgets[1].providerMaxTokens).toBeLessThan(budgets[2].providerMaxTokens);
    for (const budget of budgets) expect(budget.providerMaxTokens - budget.visibleTokens).toBe(glm.headroomTokens);
  });

  it("leaves every model that declares no budget exactly where it was", () => {
    // The one assertion that makes this change safe to ship: a model with no
    // declared budget sends byte-for-byte the envelope it always sent.
    expect(reasoningBudgetFor("glm-4.7")).toBeNull();
    expect(reasoningBudgetFor("deepseek-v4-flash")).toBeNull();
    const unchanged = completionBudgetFor(1_800, reasoningBudgetFor("glm-4.7"));
    expect(unchanged.providerMaxTokens).toBe(1_800);
    expect(unchanged.headroomTokens).toBe(0);
  });

  it("never lets a ceiling truncate the reply the reader asked for", () => {
    // A ceiling below the visible target would be a worse product than the
    // spend it guards against, so the target wins.
    const budget = completionBudgetFor(4_000, { headroomTokens: 500, ceilingTokens: 1_000 });
    expect(budget.providerMaxTokens).toBe(4_000);
  });
});

describe("a retry never repeats the budget that just failed", () => {
  const glm = reasoningBudgetFor("glm-5.3-flash")!;

  it("raises the envelope once, by one more headroom", () => {
    const budget = completionBudgetFor(1_800, glm);
    const raised = escalatedCompletionBudget(budget, budget.providerMaxTokens);
    expect(raised).toBe(budget.providerMaxTokens + glm.headroomTokens);
    expect(raised!).toBeGreaterThan(budget.providerMaxTokens);
  });

  it("stops at the model's declared ceiling rather than climbing", () => {
    /*
     * The bound that makes retrying affordable. Without it, "the envelope was
     * too small" is an argument that always succeeds, and one reader's turn can
     * spend an unbounded amount of somebody else's money on tokens nobody sees.
     */
    const budget = completionBudgetFor(1_800, glm);
    const atCeiling = escalatedCompletionBudget(budget, glm.ceilingTokens);
    expect(atCeiling).toBeNull();
    const nearCeiling = escalatedCompletionBudget(budget, glm.ceilingTokens - 10);
    expect(nearCeiling).toBe(glm.ceilingTokens);
  });

  it("has nothing to raise for a model that declares no headroom", () => {
    const budget = completionBudgetFor(1_800, null);
    expect(escalatedCompletionBudget(budget, 1_800)).toBeNull();
  });

  it("cannot ask for more room than the context budget actually left", () => {
    const budget = completionBudgetFor(1_800, glm);
    // A small model whose prompt has already eaten the window: the escalation
    // is clamped to what fits, and disappears entirely when nothing fits.
    expect(escalatedCompletionBudget(budget, 3_800, 4_200)).toBe(4_200);
    expect(escalatedCompletionBudget(budget, 3_800, 3_800)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 3. THE FAILURE HAS ITS OWN NAME                                     */
/* ------------------------------------------------------------------ */

describe("reasoning-only at finish_reason length is its own diagnosis", () => {
  function outcome(over: Partial<StreamOutcome>): StreamOutcome {
    return { ...emptyOutcome(), ...over };
  }

  it("recognises the exact trace production produced", () => {
    expect(reasoningBudgetExhausted(outcome({
      text: "", finishReason: "length", nativeFinishReason: "length", reasoningSeen: true,
    }))).toBe(true);
  });

  it("reads the usage frame when the endpoint never streamed its thinking", () => {
    /*
     * Upstreams differ in which evidence they give. An endpoint that hides its
     * reasoning sends no `delta.reasoning` at all and reports the tokens only
     * on the final usage frame; reading `reasoningSeen` alone would classify
     * half of these as an ordinary empty response and answer them by changing
     * host, which fixes nothing.
     */
    const usage = { completion_tokens: 1_800, completion_tokens_details: { reasoning_tokens: 1_800 } };
    expect(reasoningTokensIn(usage)).toBe(1_800);
    expect(reasoningBudgetExhausted(outcome({ text: "", finishReason: "length", reasoningSeen: false, usage }))).toBe(true);
  });

  it("is not claimed for an empty reply that simply ran out of room", () => {
    // No reasoning anywhere: a truncated silence is a different problem, and
    // giving it a bigger envelope is a guess rather than a diagnosis.
    expect(reasoningBudgetExhausted(outcome({ text: "", finishReason: "length" }))).toBe(false);
    expect(reasoningTokensIn(null)).toBe(0);
    expect(reasoningTokensIn({ completion_tokens_details: { reasoning_tokens: 0 } })).toBe(0);
  });

  it("is not claimed when the model reasoned and then finished", () => {
    expect(reasoningBudgetExhausted(outcome({ text: "", finishReason: "stop", reasoningSeen: true }))).toBe(false);
  });

  it("is never claimed once prose has reached the reader", () => {
    expect(reasoningBudgetExhausted(outcome({
      text: "*She looks up.*", finishReason: "length", reasoningSeen: true,
    }))).toBe(false);
  });

  it("is retryable, and says nothing to the reader about token envelopes", () => {
    const error = new ProviderError("reasoning_budget_exhausted");
    expect(error.retryable).toBe(true);
    expect(publicErrorMessage(error)).toBe("The model did not return a reply. Please try again.");
    expect(publicErrorMessage(error)).not.toMatch(/token|reasoning|budget|envelope/i);
  });
});

/* ------------------------------------------------------------------ */
/* 4. WHAT THE CHAT ROUTE ACTUALLY BUILDS                              */
/* ------------------------------------------------------------------ */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const deepSeekStream = vi.fn();
const openRouterStream = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => deepSeekStream(...args),
    completionWithUsage: vi.fn().mockResolvedValue({ content: "{}", usage: null }),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});
vi.mock("@/lib/openrouter", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => openRouterStream(...args),
    completionWithUsage: async () => ({ content: "{}", usage: null }),
    embed: async () => ({ embeddings: [], usage: null, model: "" }),
    providerHeadersTimeoutMs: () => 20_000,
    maxAttempts: 3,
    ProviderError: errors.ProviderError,
  };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000053";
const conversationId = "cccccccc-0000-4000-8000-000000000053";

/** One SSE stream from an arbitrary list of frames. */
function chunks(...lines: object[]) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

/** The exact trace from production: thinking, then length, and no prose. */
function reasoningOnlyStream() {
  return chunks(
    { id: "gen", provider: "Z.AI", choices: [{ delta: { reasoning: "considering the scene…" } }] },
    {
      choices: [{ delta: {}, finish_reason: "length", native_finish_reason: "length" }],
      usage: { prompt_tokens: 900, completion_tokens: 3_800, completion_tokens_details: { reasoning_tokens: 3_800 } },
    },
  );
}

function replyStream(text = "*She looks up.*") {
  return chunks({ choices: [{ delta: { content: text } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] });
}

async function generate() {
  const response = await chat.POST(new Request("http://test/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, content: "Say something.", action: "send" }),
  }));
  const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  return { status: response.status, events };
}

type SentOptions = { thinking?: unknown; maxTokens?: number; excludeProviders?: string[] };
const sent = (index: number) => openRouterStream.mock.calls[index][2] as SentOptions;

/** Every diagnostic line the turn wrote, as parsed objects. */
let generationLines: Array<Record<string, unknown>>;

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  deepSeekStream.mockReset();
  openRouterStream.mockReset();
  account = { id: owner, email: null };
  generationLines = [];
  const capture = (payload: unknown) => {
    try { generationLines.push(JSON.parse(String(payload)) as Record<string, unknown>); } catch { /* not a diagnostic line */ }
  };
  vi.spyOn(console, "error").mockImplementation((_label, payload) => capture(payload));
  vi.spyOn(console, "warn").mockImplementation((_label, payload) => capture(payload));
  vi.spyOn(console, "info").mockImplementation((_label, payload) => capture(payload));
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "false");
  vi.stubEnv("ENABLE_OPENROUTER", "true");
  vi.stubEnv("OPENROUTER_API_KEY", "or-test-secret");
  vi.stubEnv("ALLOWED_MODELS", "glm-5.3-flash,glm-4.7");
  vi.stubEnv("CHAT_GENERATION_DIAGNOSTICS", "1");
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query(
    `INSERT INTO conversations (id,user_id,character_id,title,message_count,provider_id,model_id)
     VALUES ($1,$2,$3,'Story',1,'openrouter','glm-5.3-flash')`,
    [conversationId, owner, characterId],
  );
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')",
    [crypto.randomUUID(), conversationId, owner]);
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("the request the chat route builds for GLM 5.3 Flash", () => {
  it("asks for low effort, and never for none", async () => {
    openRouterStream.mockResolvedValueOnce(replyStream());
    expect((await generate()).status).toBe(200);
    /*
     * The whole point of the sprint in one assertion. `"off"` here is the
     * request that collects a 400 and recovers into MORE reasoning; the
     * adaptation path that recovers it is a safety net for an endpoint nobody
     * has met, and it must not be this model's normal route to a reply.
     */
    expect(sent(0).thinking).toBe("low");
    expect(sent(0).thinking).not.toBe("off");
    expect(sent(0).thinking).not.toBe(false);
    // One request. Not a refusal, a 400 and a second attempt.
    expect(openRouterStream).toHaveBeenCalledTimes(1);
  });

  it("sends the visible reply budget plus hidden headroom", async () => {
    openRouterStream.mockResolvedValueOnce(replyStream());
    await generate();
    const glm = reasoningBudgetFor("glm-5.3-flash")!;
    // 1,800 is the account default and the Natural target. What goes on the
    // wire is that plus the headroom, so the reply is not competing with the
    // thinking for its own words.
    expect(sent(0).maxTokens).toBe(1_800 + glm.headroomTokens);
    const line = generationLines.find((entry) => entry.model === "glm-5.3-flash" && entry.maxTokens !== undefined)!;
    expect(line.visibleReplyTokens).toBe(1_800);
    expect(line.reasoningHeadroomTokens).toBe(glm.headroomTokens);
    expect(line.reasoning).toBe("low");
  });

  it("keeps Concise smaller than Natural with the headroom applied", async () => {
    await query("UPDATE conversations SET response_length='concise' WHERE id=$1", [conversationId]);
    openRouterStream.mockResolvedValueOnce(replyStream());
    await generate();
    const concise = sent(0).maxTokens!;
    const glm = reasoningBudgetFor("glm-5.3-flash")!;
    expect(concise).toBeLessThan(1_800 + glm.headroomTokens);
    // And the mode still means what it means: the visible half shrank, the
    // hidden half did not.
    expect(concise - glm.headroomTokens).toBeLessThan(1_800);
  });
});

describe("when the envelope still goes entirely on thinking", () => {
  it("retries with a bigger envelope, not the identical doomed one", async () => {
    openRouterStream
      .mockResolvedValueOnce(reasoningOnlyStream())
      .mockResolvedValueOnce(replyStream());
    const { events } = await generate();
    expect(events.find((event) => event.type === "done")).toBeTruthy();
    expect(openRouterStream).toHaveBeenCalledTimes(2);
    // The retry is DIFFERENT, and different in the way the failure named.
    expect(sent(1).maxTokens!).toBeGreaterThan(sent(0).maxTokens!);
    /*
     * And it does not ask for no reasoning. That is the ordinary answer to an
     * envelope spent on thinking, and on this endpoint it is a 400 with the
     * reader's last attempt attached to it.
     */
    expect(sent(1).thinking).toBe("low");
    expect(sent(1).thinking).not.toBe("off");
    // The host produced a great deal; it simply had nowhere to put the answer.
    // Excluding it would throw away the one endpoint this model has, and the
    // warm prompt cache with it.
    expect(sent(1).excludeProviders ?? []).toEqual([]);
  });

  it("stays inside the model's ceiling on that one escalation", async () => {
    openRouterStream
      .mockResolvedValueOnce(reasoningOnlyStream())
      .mockResolvedValueOnce(replyStream());
    await generate();
    expect(sent(1).maxTokens!).toBeLessThanOrEqual(reasoningBudgetFor("glm-5.3-flash")!.ceilingTokens);
    // Two attempts and no more: the escalation is once, not a ladder.
    expect(openRouterStream).toHaveBeenCalledTimes(2);
  });

  it("is diagnosed as an exhausted budget rather than an empty response", async () => {
    openRouterStream
      .mockResolvedValueOnce(reasoningOnlyStream())
      .mockResolvedValueOnce(reasoningOnlyStream());
    const { events } = await generate();
    const failure = events.find((event) => event.type === "error")!;
    // The reader gets one calm sentence, exactly as before.
    expect(failure.error).toBe("The model did not return a reply. Please try again.");
    // The operator gets the difference between "no host answered" and "the
    // envelope we chose was too small", which have opposite remedies.
    const failed = generationLines.find((entry) => entry.outcome === "failed")!;
    expect(failed.reason).toBe("reasoning_budget_exhausted");
    expect(failed.category).toBe("reasoning_budget_exhausted");
    expect(failed.reason).not.toBe("empty_response");
    expect(String(failed.detail)).toContain("finish_reason=length");
    expect(failed.retryMaxTokens).toBe(sent(1).maxTokens);
  });
});

describe("no other model's request moved", () => {
  it("leaves a model that declares neither a default nor a budget alone", async () => {
    await query("UPDATE conversations SET model_id='glm-4.7' WHERE id=$1", [conversationId]);
    openRouterStream.mockResolvedValueOnce(replyStream());
    await generate();
    // Says nothing about reasoning, and sends the envelope Response Length
    // asked for and not one token more.
    expect(sent(0).thinking).toBe(false);
    expect(sent(0).maxTokens).toBe(1_800);
  });

  it("still answers a reasoning-only reply by declining reasoning where it can", async () => {
    /*
     * The behaviour this sprint must not break. On an endpoint that accepts
     * `"off"`, the right answer to an envelope spent on thinking is still to
     * ask for none — cheaper, faster, and it does not raise anybody's bill.
     * Only an endpoint that refuses the refusal gets the larger envelope.
     */
    await query("UPDATE conversations SET model_id='glm-4.7' WHERE id=$1", [conversationId]);
    openRouterStream
      .mockResolvedValueOnce(reasoningOnlyStream())
      .mockResolvedValueOnce(replyStream());
    await generate();
    expect(sent(1).thinking).toBe("off");
    // And no escalation, because the model declares no headroom to escalate.
    expect(sent(1).maxTokens).toBe(sent(0).maxTokens);
  });
});
