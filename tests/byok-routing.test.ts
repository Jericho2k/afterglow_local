import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userId = "11111111-1111-4111-8111-111111111111";
const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
let account: { id: string; email: string | null } | null = { id: userId, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const { storeValidatedProviderKey } = await import("@/lib/byok");
const { resetRateLimitsForTesting } = await import("@/lib/rate-limit");
const chat = await import("@/app/api/chat/route");

function post(action: "send" | "regenerate" | "continue", content = action === "send" ? "Hello" : "") {
  return new Request("http://test/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.10" },
    body: JSON.stringify({ conversationId, content, action }),
  });
}

function successfulStream() {
  return [
    `data: ${JSON.stringify({ id: crypto.randomUUID(), model: "xiaomi/mimo-v2.5", provider: "Xiaomi", choices: [{ delta: { content: "Writer reply" } }] })}\n`,
    `data: ${JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 5, cost: 0.0005 }, choices: [] })}\n`,
    "data: [DONE]\n",
  ].join("");
}

async function waitForUsage(kind: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const row = await query("SELECT funding_source,usage_type,task_route FROM usage_events WHERE user_id=$1 AND usage_type=$2", [userId, kind]);
    if (row.rowCount) return row.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return null;
}

beforeEach(async () => {
  account = { id: userId, email: null };
  resetRateLimitsForTesting();
  process.env.ENABLE_BYOK = "true";
  process.env.BYOK_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  process.env.ENABLE_OPENROUTER = "true";
  process.env.OPENROUTER_API_KEY = "platform-key";
  process.env.OPENROUTER_BASE_URL = "https://openrouter.test/api/v1";
  process.env.ALLOWED_MODELS = "deepseek-v4-flash,mimo-v2.5";
  process.env.RP_MODEL_ROUTE = "conversation";
  process.env.SCENE_STATE_ENABLED = "false";
  process.env.MEMORY_RETRIEVAL_V2_ENABLED = "false";

  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  memoryDb.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  await query("INSERT INTO user_settings (user_id,provider_id,model) VALUES ($1,'openrouter','mimo-v2.5')", [userId]);
  await query("INSERT INTO characters (id,name,user_id,greeting) VALUES ($1,'Mara',$2,'Hello')", [characterId, userId]);
  await query("INSERT INTO conversations (id,character_id,user_id,title,provider_id,model_id) VALUES ($1,$2,$3,'Story','openrouter','mimo-v2.5')", [conversationId, characterId, userId]);
  await storeValidatedProviderKey(userId, "sk-or-v1-personal-writer-key");
  vi.unstubAllGlobals();
});

describe("writer-only funding routing", () => {
  for (const action of ["send", "regenerate", "continue"] as const) {
    it(`uses BYOK and records funding for ${action}`, async () => {
      if (action !== "send") {
        await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'user','Earlier turn')", [crypto.randomUUID(), conversationId, userId]);
        await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','Earlier reply')", [crypto.randomUUID(), conversationId, userId]);
        await query("UPDATE conversations SET message_count=2 WHERE id=$1", [conversationId]);
      }
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer sk-or-v1-personal-writer-key");
        return new Response(successfulStream(), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      });
      vi.stubGlobal("fetch", fetchMock);

      const response = await chat.POST(post(action));
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.text()).toContain("Writer reply");
      expect(fetchMock).toHaveBeenCalled();
      const usage = await waitForUsage(action === "send" ? "chat" : action);
      expect(usage).toMatchObject({ funding_source: "byok", task_route: "rp_generation" });
    });
  }

  it("rejects a direct-provider model before mutation or a platform writer call", async () => {
    await query("UPDATE conversations SET provider_id='deepseek',model_id='deepseek-v4-flash' WHERE id=$1", [conversationId]);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const before = Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1", [conversationId])).rows[0].count);
    const response = await chat.POST(post("send"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "non_openrouter_model" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1", [conversationId])).rows[0].count)).toBe(before);
  });

  it("uses platform funding when the kill switch is off without deleting the key", async () => {
    process.env.ENABLE_BYOK = "false";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer platform-key");
      return new Response(successfulStream());
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await chat.POST(post("send"));
    await response.text();
    expect(await waitForUsage("chat")).toMatchObject({ funding_source: "afterglow" });
    expect(Number((await query("SELECT COUNT(*) count FROM user_provider_credentials WHERE user_id=$1", [userId])).rows[0].count)).toBe(1);
  });

  for (const [status, expected] of [[401, "no longer valid"], [402, "couldn't fund"]] as const) {
    it(`does not retry ${status} with the platform key`, async () => {
      const fetchMock = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => { void args; return new Response("rejected", { status }); });
      vi.stubGlobal("fetch", fetchMock);
      const response = await chat.POST(post("send"));
      expect(response.status).toBe(502);
      expect((await response.json()).error).toContain(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer sk-or-v1-personal-writer-key");
    });
  }
});
