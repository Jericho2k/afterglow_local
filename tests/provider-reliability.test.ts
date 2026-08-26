import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planRequestBudget, fitConversation, contextExceededMessage, minimumOutputTokens } from "@/lib/context-budget";
import { modelCapabilities, providerPolicyFor } from "@/lib/provider";

/**
 * Why a reply failed, and whether it had to.
 *
 * Two reported failures share one cause and one fix. "Something went wrong
 * while generating the response" on Midnight Cherry was a request that could
 * never have succeeded: 32,768 tokens of context against a Creation and a World
 * with no ceiling. "The model did not return a reply" was several different
 * recoverable failures wearing one message, because the stream consumer only
 * ever looked at `choices[0].delta.content`.
 */

describe("model capability is data, not a name comparison", () => {
  it("knows Midnight Cherry is the small one", () => {
    // The whole reason budgeting exists. Verified against OpenRouter's
    // catalogue: Skyfall 36B V2 reads 32,768 tokens; its two siblings read
    // 131,072 and 65,536; MiMo reads about a million.
    expect(modelCapabilities("openrouter", "midnight-cherry").contextTokens).toBe(32_768);
    expect(modelCapabilities("openrouter", "passion-fruit").contextTokens).toBe(131_072);
    expect(modelCapabilities("openrouter", "wild-peach").contextTokens).toBe(65_536);
    expect(modelCapabilities("openrouter", "mimo-v2.5").contextTokens).toBeGreaterThan(1_000_000);
  });

  it("never claims a limit it has not verified", () => {
    // An unverified number would be a guess with the authority of a constant.
    expect(modelCapabilities("deepseek", "deepseek-v4-flash").contextTokens).toBeUndefined();
    expect(modelCapabilities("openrouter", "nothing-like-this").contextTokens).toBeUndefined();
  });

  it("refuses reasoning for endpoints that do not accept it", () => {
    expect(modelCapabilities("openrouter", "midnight-cherry").thinking).toBe(false);
    expect(modelCapabilities("openrouter", "mimo-v2.5-pro").thinking).toBe(true);
    // An unknown deployment-configured model is sent nothing optional at all.
    expect(modelCapabilities("openrouter", "nothing-like-this").thinking).toBe(false);
  });
});

describe("planning a request that fits", () => {
  const cherry = modelCapabilities("openrouter", "midnight-cherry");

  it("lowers the output envelope before touching anything the reader wrote", () => {
    // A prompt just under the window: the envelope shrinks, no message is lost.
    const plan = planRequestBudget({
      capabilities: cherry,
      systemPrompt: "x".repeat(110_000),
      conversationTexts: ["y".repeat(4_000)],
      requestedMaxTokens: 2_880,
    });
    expect(plan.overflows).toBe(false);
    expect(plan.constrained).toBe(true);
    expect(plan.maxTokens).toBeLessThan(2_880);
    expect(plan.maxTokens).toBeGreaterThanOrEqual(minimumOutputTokens);
  });

  it("drops the oldest turns, never the newest exchange", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `turn ${index} ${"z".repeat(6_000)}` }));
    const fitted = fitConversation(messages, {
      capabilities: cherry,
      systemPrompt: "x".repeat(20_000),
      requestedMaxTokens: 2_880,
    });
    expect(fitted.dropped).toBeGreaterThan(0);
    expect(fitted.plan.overflows).toBe(false);
    // Only the front is trimmed: the newest turn is always still there.
    expect(fitted.messages.at(-1)).toEqual(messages.at(-1));
    expect(fitted.messages[0].content.startsWith("turn ")).toBe(true);
  });

  it("refuses rather than truncating a creator's World", () => {
    // 100,000 characters of lore is about 28,000 tokens, which does not fit in
    // 32,768 alongside anything else. Cutting it silently would produce a
    // confident, wrong reply; the caller returns an actionable error instead.
    const fitted = fitConversation([{ content: "the newest turn" }, { content: "and the reply" }], {
      capabilities: cherry,
      systemPrompt: "w".repeat(130_000),
      requestedMaxTokens: 1_800,
    });
    expect(fitted.plan.overflows).toBe(true);
    expect(fitted.plan.overflowTokens).toBeGreaterThan(0);
    expect(contextExceededMessage).toContain("larger context");
    expect(contextExceededMessage).toContain("untouched");
  });

  it("does not constrain a model whose window is unverified", () => {
    const plan = planRequestBudget({
      capabilities: modelCapabilities("deepseek", "deepseek-v4-flash"),
      systemPrompt: "x".repeat(500_000),
      conversationTexts: [],
      requestedMaxTokens: 1_800,
    });
    expect(plan.overflows).toBe(false);
    expect(plan.maxTokens).toBe(1_800);
  });
});

describe("same-model failover", () => {
  it("prefers Xiaomi for MiMo without pinning it", () => {
    const first = providerPolicyFor("mimo-v2.5", 0, []);
    expect(first?.order).toEqual(["xiaomi"]);
    // The critical half: a Xiaomi outage must not take MiMo down.
    expect(first?.allowFallbacks).toBe(true);
    expect(first?.only).toBeUndefined();
  });

  it("excludes a host that has already failed this request", () => {
    const retry = providerPolicyFor("mimo-v2.5", 1, ["gmicloud"]);
    expect(retry?.ignore).toEqual(["gmicloud"]);
    expect(retry?.allowFallbacks).toBe(true);
    expect(retry?.sort).toBe("throughput");
  });

  it("pins a single endpoint only when an operator asks for a benchmark", () => {
    vi.stubEnv("PIN_UPSTREAM_PROVIDER", "mimo-v2.5:xiaomi");
    expect(providerPolicyFor("mimo-v2.5", 0, [])).toEqual({ only: ["xiaomi"], allowFallbacks: false });
    // Scoped to the model named, so pinning one cannot pin the rest.
    expect(providerPolicyFor("midnight-cherry", 0, [])?.only).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("leaves the first attempt untouched for a model with no preference", () => {
    // The warm path: whatever OpenRouter would have done, so a sticky session
    // stays where its cache already is.
    expect(providerPolicyFor("midnight-cherry", 0, [])).toBeNull();
  });
});

/** The stream-level failures, against the real route. */
const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
    completionWithUsage: vi.fn().mockResolvedValue({ content: "{}", usage: null }),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";

function chunks(...lines: object[]) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}
async function generate() {
  const response = await chat.POST(new Request("http://test/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, content: "Say something.", action: "send" }),
  }));
  const events = (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { status: response.status, events };
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  streamCompletion.mockReset();
  account = { id: owner, email: null };
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "false");
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',1)", [conversationId, owner, characterId]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')", [crypto.randomUUID(), conversationId, owner]);
});

describe("an empty reply is diagnosed rather than guessed at", () => {
  it("reports an error the provider delivered inside the stream", async () => {
    // OpenRouter reports a mid-stream failure as a data chunk. The consumer
    // only read `choices[0].delta.content`, so this was silently discarded and
    // surfaced as "the model did not return a reply" — losing the reason AND
    // the fact that it was worth retrying.
    streamCompletion.mockResolvedValueOnce(chunks({ error: { message: "upstream capacity exceeded", code: 429 } }));
    const { events } = await generate();
    const failure = events.find((event) => event.type === "error");
    expect(failure.error).toBe("The model is temporarily busy. Please try again in a moment.");
    // And the reader never sees the upstream's own words.
    expect(failure.error).not.toContain("capacity");
  });

  it("says something true when the provider's safety layer refused", async () => {
    streamCompletion.mockResolvedValueOnce(chunks({ choices: [{ delta: {}, finish_reason: "content_filter" }] }));
    const { events } = await generate();
    const failure = events.find((event) => event.type === "error");
    expect(failure.error).toContain("declined to continue this scene");
    // Retrying a refusal produces the refusal again, so it is not retried.
    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });

  it("retries a reasoning-only response with reasoning turned off", async () => {
    streamCompletion
      .mockResolvedValueOnce(chunks({ choices: [{ delta: { reasoning: "thinking…" } }] }, { choices: [{ delta: {}, finish_reason: "length" }] }))
      .mockResolvedValueOnce(chunks({ choices: [{ delta: { content: "*She looks up.*" } }] }));
    const { events } = await generate();
    expect(events.find((event) => event.type === "done")).toBeTruthy();
    expect(streamCompletion).toHaveBeenCalledTimes(2);
    const retryOptions = streamCompletion.mock.calls[1][1] as { thinking?: boolean; excludeProviders?: string[] };
    expect(retryOptions.thinking).toBe(false);
  });

  it("asks a different host on the retry after a silent one", async () => {
    streamCompletion
      .mockResolvedValueOnce(chunks({ provider: "someprovider", choices: [{ delta: {} }] }))
      .mockResolvedValueOnce(chunks({ choices: [{ delta: { content: "*She looks up.*" } }] }));
    await generate();
    const retryOptions = streamCompletion.mock.calls[1][1] as { excludeProviders?: string[] };
    expect(retryOptions.excludeProviders).toEqual(["someprovider"]);
  });

  it("never retries once visible text has reached the reader", async () => {
    // The rule that matters most: appending a second, independent generation on
    // top of prose already on screen is a worse failure than the one it hides.
    streamCompletion.mockResolvedValueOnce(chunks({ choices: [{ delta: { content: "*She looks up.*" } }] }));
    const { events } = await generate();
    expect(events.filter((event) => event.type === "delta")).toHaveLength(1);
    expect(streamCompletion).toHaveBeenCalledTimes(1);
  });
});
