import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the chat route actually hands the provider, and what it hands the reader.
 *
 * Every claim in this sprint that could otherwise be argued from source alone
 * is settled here against a real request: the output budget each Response
 * Length sends, which setting wins, whether a custom instruction reaches the
 * writer once, whether a conversation's session identifier is stable, and —
 * the one that matters most — whether a raw provider failure can reach a
 * reader's screen.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };
const streamCompletion = vi.fn();
const completionWithUsage = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

vi.mock("@/lib/deepseek", async () => {
  const errors = await vi.importActual<typeof import("@/lib/provider-errors")>("@/lib/provider-errors");
  return {
    streamCompletion: (...args: unknown[]) => streamCompletion(...args),
    completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
    parseJson: (value: string) => JSON.parse(value),
    ProviderError: errors.ProviderError,
  };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const { ProviderError } = await import("@/lib/provider-errors");
const chat = await import("@/app/api/chat/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const otherConversationId = "cccccccc-0000-4000-8000-000000000002";

function post(body: unknown) {
  return new Request("http://test/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function textStream(text: string) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n"));
      controller.close();
    },
  });
}

async function send(id = conversationId) {
  streamCompletion.mockResolvedValueOnce(textStream("*She looks up.*"));
  completionWithUsage.mockResolvedValue({ content: "{}", usage: null });
  const response = await chat.POST(post({ conversationId: id, content: "Say something.", action: "send" }));
  return { status: response.status, body: await response.text() };
}

/** The options object the provider adapter was called with. */
function callOptions(index = 0) {
  return streamCompletion.mock.calls[index][1] as { maxTokens?: number; sessionId?: string; temperature?: number };
}

function systemPrompt(index = 0) {
  const messages = streamCompletion.mock.calls[index][0] as Array<{ role: string; content: string }>;
  return messages[0].content;
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
  completionWithUsage.mockReset();
  account = { id: owner, email: null };
  vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
  vi.stubEnv("SCENE_STATE_ENABLED", "false");

  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  for (const id of [conversationId, otherConversationId]) {
    await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',1)", [id, owner, characterId]);
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','*Maya waits.*')", [crypto.randomUUID(), id, owner]);
  }
});

async function setAccountDefault(responseLength: string) {
  await query(
    `INSERT INTO user_settings (user_id,response_length) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET response_length=EXCLUDED.response_length`,
    [owner, responseLength],
  );
}

describe("response length reaches the provider", () => {
  it("sends a different output budget for each choice", async () => {
    const budgets: Record<string, number> = {};
    for (const length of ["concise", "natural", "detailed"]) {
      streamCompletion.mockReset();
      await query("UPDATE conversations SET response_length=$1 WHERE id=$2", [length, conversationId]);
      expect((await send()).status).toBe(200);
      budgets[length] = callOptions().maxTokens ?? 0;
    }
    // The whole point: three choices, three envelopes, not one shared ceiling.
    expect(budgets.concise).toBeLessThan(budgets.natural);
    expect(budgets.natural).toBeLessThan(budgets.detailed);
  });

  it("lets a conversation override beat the account default", async () => {
    await setAccountDefault("detailed");
    await query("UPDATE conversations SET response_length='concise' WHERE id=$1", [conversationId]);
    await send();
    const overridden = callOptions().maxTokens ?? 0;
    expect(systemPrompt()).toContain("CONCISE (ACTIVE REQUIREMENT)");

    // Clearing the override falls back to the account default, not to Natural.
    streamCompletion.mockReset();
    await query("UPDATE conversations SET response_length=NULL WHERE id=$1", [conversationId]);
    await send();
    expect(systemPrompt()).toContain("DETAILED (ACTIVE REQUIREMENT)");
    expect(callOptions().maxTokens ?? 0).toBeGreaterThan(overridden);
  });
});

describe("chat instructions reach the writer", () => {
  it("includes every selected preset and the custom text exactly once", async () => {
    await query(
      "UPDATE conversations SET instruction_presets=$1,custom_instructions=$2 WHERE id=$3",
      [["reduce_repetition", "stay_focused"], "Never mention the weather.", conversationId],
    );
    await send();
    const prompt = systemPrompt();
    expect(prompt).toContain("Actively avoid repeating recent material.");
    expect(prompt).toContain("Keep the response centered on the user's latest meaningful actions");
    expect(prompt.split("Never mention the weather.").length - 1).toBe(1);
  });

  it("drops the custom instruction once it has been cleared", async () => {
    await query("UPDATE conversations SET custom_instructions=$1 WHERE id=$2", ["Never mention the weather.", conversationId]);
    await send();
    expect(systemPrompt()).toContain("Never mention the weather.");

    streamCompletion.mockReset();
    await query("UPDATE conversations SET custom_instructions='' WHERE id=$1", [conversationId]);
    await send();
    expect(systemPrompt()).not.toContain("Never mention the weather.");
  });
});

describe("provider session identity", () => {
  it("is stable within a conversation and different between conversations", async () => {
    await send();
    const first = callOptions().sessionId;
    streamCompletion.mockReset();
    await send();
    const second = callOptions().sessionId;
    streamCompletion.mockReset();
    await send(otherConversationId);
    const other = callOptions().sessionId;

    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(other).not.toBe(first);
    // Opaque: a provider log must not be able to read the conversation id off it.
    expect(first).not.toContain(conversationId);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("provider failures never reach the reader raw", () => {
  const rawBody = '{"error":{"message":"Provider Parasail returned 429 from shared pool https://api.parasail.io/v1/chat","metadata":{"provider_name":"Parasail"}}}';

  it("replaces a raw upstream 429 with product text before the stream starts", async () => {
    streamCompletion.mockRejectedValueOnce(new ProviderError("rate_limited", {
      provider: "openrouter", model: "kimi-k2.5", status: 429, detail: rawBody,
    }));
    const response = await chat.POST(post({ conversationId, content: "Hello", action: "send" }));
    const payload = await response.json() as { error: string };

    expect(response.status).toBe(429);
    expect(payload.error).toBe("The model is temporarily busy. Please try again in a moment.");
    for (const leak of ["Parasail", "429", "shared pool", "https://", "provider_name", "kimi"]) {
      expect(payload.error, `${leak} must never reach a reader`).not.toContain(leak);
    }
  });

  it("replaces a raw failure that happens mid-stream too", async () => {
    streamCompletion.mockRejectedValueOnce(new ProviderError("upstream_unavailable", { detail: rawBody }));
    const response = await chat.POST(post({ conversationId, content: "Hello", action: "send" }));
    const body = await response.text();
    expect(body).not.toContain("Parasail");
  });

  it("keeps the whole diagnostic internally", () => {
    const error = new ProviderError("rate_limited", { provider: "openrouter", model: "kimi-k2.5", status: 429, detail: rawBody });
    // The operator can still see everything; it simply is not `message`.
    expect(error.diagnostic.detail).toContain("Parasail");
    expect(error.diagnostic.status).toBe(429);
    expect(error.message).not.toContain("Parasail");
  });
});
