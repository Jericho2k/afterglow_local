import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level authorisation.
 *
 * These run against the in-memory database, so they verify the explicit
 * ownership predicates the routes carry rather than the policies (which
 * tenancy.test.ts covers against a real PostgreSQL). The two layers are meant
 * to fail independently, and this is the half that survives a policy mistake.
 */

const alice = "11111111-1111-4111-8111-111111111111";
const bob = "22222222-2222-4222-8222-222222222222";

let account: { id: string; email: string | null } | null = null;
const streamCompletion = vi.fn();
const completionWithUsage = vi.fn();

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

vi.mock("@/lib/deepseek", () => ({
  streamCompletion: (...args: unknown[]) => streamCompletion(...args),
  completionWithUsage: (...args: unknown[]) => completionWithUsage(...args),
  parseJson: (value: string) => JSON.parse(value),
}));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const chat = await import("@/app/api/chat/route");
const characters = await import("@/app/api/characters/route");
const conversations = await import("@/app/api/conversations/route");
const memories = await import("@/app/api/memories/route");
const backup = await import("@/app/api/backup/route");
const usage = await import("@/app/api/usage/route");

const aliceCharacter = "aaaaaaaa-0000-4000-8000-000000000001";
const alicePublic = "aaaaaaaa-0000-4000-8000-000000000002";
const aliceConversation = "cccccccc-0000-4000-8000-000000000001";

function post(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  // The usage ledger buckets by day; pg-mem ships very few native functions.
  memoryDb.public.registerFunction({
    name: "date_trunc",
    args: [DataType.text, DataType.timestamptz],
    returns: DataType.timestamptz,
    implementation: (unit: string, value: Date) => {
      const truncated = new Date(value);
      if (unit === "day") truncated.setHours(0, 0, 0, 0);
      return truncated;
    },
  });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  streamCompletion.mockReset();
  completionWithUsage.mockReset();
  account = null;

  await query("INSERT INTO characters (id,name,user_id,visibility) VALUES ($1,'Alice Private',$3,'private'),($2,'Alice Public',$3,'public')", [aliceCharacter, alicePublic, alice]);
  await query("INSERT INTO conversations (id,character_id,user_id,title) VALUES ($1,$2,$3,'Alice chat')", [aliceConversation, aliceCharacter, alice]);
  await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($4,$1,$2,'user','Private words')", [aliceConversation, alice, null, crypto.randomUUID()]);
  await query("INSERT INTO memories (id,character_id,conversation_id,user_id,content) VALUES ($4,$1,$2,$3,'Alice memory')", [aliceCharacter, aliceConversation, alice, crypto.randomUUID()]);
  await query("INSERT INTO usage_events (id,user_id,model,usage_type,estimated_cost_usd) VALUES ($2,$1,'deepseek-v4-flash','chat',2.5)", [alice, crypto.randomUUID()]);
});

describe("unauthenticated access", () => {
  it("refuses every private endpoint", async () => {
    const responses = await Promise.all([
      characters.GET(new Request("http://test/api/characters")),
      conversations.GET(new Request("http://test/api/conversations?characterId=" + aliceCharacter)),
      memories.GET(new Request("http://test/api/memories?characterId=" + aliceCharacter)),
      backup.GET(),
      usage.GET(),
      chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" })),
    ]);
    for (const response of responses) expect(response.status).toBe(401);
  });

  it("never reaches the model provider", async () => {
    await chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" }));
    expect(streamCompletion).not.toHaveBeenCalled();
  });
});

describe("cross-account access", () => {
  it("creates an isolated conversation branch through the selected message", async () => {
    account = { id: alice, email: null };
    const sourceMessage = await query("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1",[aliceConversation]);
    const response = await conversations.POST(post("http://test/api/conversations",{
      branchFromConversationId:aliceConversation,
      branchFromMessageId:String(sourceMessage.rows[0].id),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation.id).not.toBe(aliceConversation);
    expect(body.conversation.title).toContain("Branch");
    expect(body.messages.map((message:{content:string})=>message.content)).toEqual(["Private words"]);
    expect(Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[aliceConversation])).rows[0].count)).toBe(1);
  });

  it("lists only the caller's complete chat index", async () => {
    account = { id: bob, email: null };
    const bobView = await (await conversations.GET(new Request("http://test/api/conversations?scope=all"))).json();
    expect(bobView.conversations).toEqual([]);

    account = { id: alice, email: null };
    const aliceView = await (await conversations.GET(new Request("http://test/api/conversations?scope=all"))).json();
    expect(aliceView.conversations.map((item: { id: string }) => item.id)).toContain(aliceConversation);
  });

  it("rejects a conversation id belonging to another account before spending tokens", async () => {
    account = { id: bob, email: "bob@example.com" };
    const response = await chat.POST(post("http://test/api/chat", { conversationId: aliceConversation, content: "hi", action: "send" }));
    expect(response.status).toBe(404);
    expect(streamCompletion).not.toHaveBeenCalled();
    // The rejected request must not have written a message either.
    const stored = await query("SELECT COUNT(*)::int count FROM messages WHERE conversation_id=$1", [aliceConversation]);
    expect(Number(stored.rows[0].count)).toBe(1);
  });

  it("does not list another account's characters", async () => {
    account = { id: bob, email: null };
    const response = await characters.GET(new Request("http://test/api/characters"));
    const body = await response.json();
    expect(body.characters).toEqual([]);
  });

  it("does not return another account's memories", async () => {
    account = { id: bob, email: null };
    const response = await memories.GET(new Request(`http://test/api/memories?characterId=${aliceCharacter}&conversationId=${aliceConversation}`));
    const body = await response.json();
    expect(body.memories).toEqual([]);
  });

  it("refuses to hang a memory off another account's conversation", async () => {
    account = { id: bob, email: null };
    const response = await memories.POST(post("http://test/api/memories", { characterId: alicePublic, conversationId: aliceConversation, content: "injected" }));
    expect(response.status).toBe(404);
  });

  it("scopes the usage ledger to the caller", async () => {
    account = { id: bob, email: null };
    const body = await (await usage.GET()).json();
    expect(body.usage.requests).toBe(0);
    expect(body.usage.estimatedCostUsd).toBe(0);

    account = { id: alice, email: null };
    const own = await (await usage.GET()).json();
    expect(own.usage.requests).toBe(1);
  });

  it("scopes the backup export to the caller", async () => {
    account = { id: bob, email: null };
    const empty = await (await backup.GET()).json();
    expect(empty.characters).toEqual([]);
    expect(empty.conversations).toEqual([]);
    expect(empty.messages).toEqual([]);

    account = { id: alice, email: null };
    const mine = await (await backup.GET()).json();
    expect(mine.characters).toHaveLength(2);
    expect(mine.messages).toHaveLength(1);
  });
});

describe("public characters", () => {
  it("stores every opening as an instantly selectable first-message variant", async () => {
    await query("UPDATE characters SET greeting='Opening one',alternate_greetings=$2::jsonb WHERE id=$1", [alicePublic, JSON.stringify(["Opening two","Opening three"])]);
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.messages[0]).toMatchObject({ content: "Opening one", variants: ["Opening one","Opening two","Opening three"], selectedVariant: 0 });
  });

  it("lets another account start a chat that stays private", async () => {
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation).toMatchObject({ providerId:"deepseek",modelId:"deepseek-v4-flash",rpEngineId:"immersive" });

    const owner = await query("SELECT user_id, character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(String(owner.rows[0].user_id)).toBe(bob);
    // Somebody else's character is frozen at the definition the chat started from.
    expect(owner.rows[0].character_snapshot).toBeTruthy();
    const recentCharacters = await (await characters.GET(new Request("http://test/api/characters?scope=chats"))).json();
    expect(recentCharacters.characters.some((item: {id:string;ownedByViewer:boolean})=>item.id===alicePublic&&!item.ownedByViewer)).toBe(true);

    account = { id: alice, email: null };
    const aliceView = await conversations.GET(new Request(`http://test/api/conversations?characterId=${alicePublic}`));
    const aliceBody = await aliceView.json();
    expect(aliceBody.conversations.every((item: { id: string }) => item.id !== body.conversation.id)).toBe(true);
  });

  it("does not expose the creator's import source material to other accounts", async () => {
    await query("UPDATE characters SET source_material='Private production notes' WHERE id=$1", [alicePublic]);
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: alicePublic }));
    const body = await response.json();
    const stored = await query("SELECT character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(JSON.stringify(stored.rows[0].character_snapshot)).not.toContain("Private production notes");

    const published = await characters.GET(new Request("http://test/api/characters?scope=published"));
    const list = await published.json();
    expect(list.characters).toHaveLength(1);
    expect(list.characters[0].sourceMaterial).toBe("");
    expect(list.characters[0].ownedByViewer).toBe(false);
  });

  it("refuses to start a chat from a character that is private to somebody else", async () => {
    account = { id: bob, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: aliceCharacter }));
    expect(response.status).toBe(404);
  });

  it("keeps the owner's own chat reading the live character", async () => {
    account = { id: alice, email: null };
    const response = await conversations.POST(post("http://test/api/conversations", { characterId: aliceCharacter }));
    const body = await response.json();
    const stored = await query("SELECT character_snapshot FROM conversations WHERE id=$1", [body.conversation.id]);
    expect(stored.rows[0].character_snapshot).toBeNull();
  });
});
