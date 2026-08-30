import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reader owning their own archive.
 *
 * The properties here are the ones that make an editable memory library safe:
 * an edit has to change what gets retrieved NEXT time, it has to invalidate the
 * vector that described the old wording, removal has to stop future recall
 * without rewriting the past, and none of it may reach across accounts.
 */

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = { id: owner, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({ streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (v: string) => JSON.parse(v) }));

const { ensureSchema, query, setPoolForTesting, memoryFromRow } = await import("@/lib/db");
const memories = await import("@/app/api/memories/route");
const recall = await import("@/app/api/messages/[id]/recall/route");
const { rankMemories } = await import("@/lib/memory");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const otherConversation = "cccccccc-0000-4000-8000-000000000002";
const messageId = "dddddddd-0000-4000-8000-000000000001";

const post = (url: string, body: unknown, method = "POST") => new Request(url, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  const adapter = database.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();
  // A plain shell of the vector table: the deletion this asserts touches only
  // the two key columns, and pg-mem has no vector type to declare.
  await query("CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id uuid PRIMARY KEY, user_id uuid, embedding text, embedding_model text NOT NULL DEFAULT '', content_hash text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())");
  account = { id: owner, email: null };
  vi.stubEnv("AFTERGLOW_ADMIN_USER_IDS", "");
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, owner, characterId]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Branch')", [otherConversation, owner, characterId]);
});

async function add(content: string, extra: Record<string, unknown> = {}) {
  const response = await memories.POST(post("http://test/api/memories", { characterId, conversationId, content, ...extra }));
  expect(response.status).toBe(201);
  return (await response.json()).memory as { id: string; content: string; origin?: string };
}

async function list(url = `http://test/api/memories?characterId=${characterId}&conversationId=${conversationId}`) {
  const response = await memories.GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

async function storedMemories() {
  const result = await query("SELECT * FROM memories WHERE user_id=$1", [owner]);
  return result.rows.map(memoryFromRow);
}

describe("manual memory management", () => {
  it("lets an ordinary account add a memory, marked as its own", async () => {
    const created = await add("She keeps her mother's watch in the left drawer.");
    expect(created.origin).toBe("user");
    const { body } = await list();
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0].content).toContain("left drawer");
  });

  it("makes an edit change what future retrieval finds", async () => {
    const created = await add("She keeps her mother's watch in the left drawer.", { keywords: ["watch"] });
    const before = rankMemories(await storedMemories(), "Where is the compass?");
    expect(before.map((item) => item.id)).not.toContain(created.id);

    const edited = await memories.PATCH(post(`http://test/api/memories?id=${created.id}`, {
      content: "She keeps her father's compass in the left drawer.", kind: "event", importance: 4, keywords: ["compass"], pinned: false,
    }, "PATCH"));
    expect(edited.status).toBe(200);

    const after = rankMemories(await storedMemories(), "Where is the compass?");
    expect(after.map((item) => item.id)).toContain(created.id);
    expect(after[0].content).toContain("compass");
  });

  it("drops the stored vector when the text changes, and keeps it when only a flag does", async () => {
    const created = await add("A fact worth remembering.");
    const seed = async () => query("INSERT INTO memory_embeddings (memory_id,user_id,embedding,content_hash) VALUES ($1,$2,'[0]','stale') ON CONFLICT (memory_id) DO NOTHING", [created.id, owner]);
    const embeddings = async () => Number((await query("SELECT COUNT(*)::int count FROM memory_embeddings WHERE memory_id=$1", [created.id])).rows[0].count);

    await seed();
    await memories.PATCH(post(`http://test/api/memories?id=${created.id}`, { content: "A fact worth remembering.", kind: "event", importance: 5, keywords: [], pinned: true }, "PATCH"));
    expect(await embeddings()).toBe(1);

    await memories.PATCH(post(`http://test/api/memories?id=${created.id}`, { content: "Actually a different fact entirely.", kind: "event", importance: 5, keywords: [], pinned: true }, "PATCH"));
    expect(await embeddings()).toBe(0);
  });

  it("pins and unpins", async () => {
    const created = await add("Remember the anniversary is in March.");
    await memories.PATCH(post(`http://test/api/memories?id=${created.id}`, { content: created.content, kind: "event", importance: 3, keywords: [], pinned: true }, "PATCH"));
    expect((await storedMemories())[0].pinned).toBe(true);
    await memories.PATCH(post(`http://test/api/memories?id=${created.id}`, { content: created.content, kind: "event", importance: 3, keywords: [], pinned: false }, "PATCH"));
    expect((await storedMemories())[0].pinned).toBe(false);
  });
});

describe("removal", () => {
  it("supersedes rather than deletes, so future recall stops but the past stays legible", async () => {
    const created = await add("He promised to call on Sunday.", { kind: "promise", keywords: ["Sunday"] });
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content,memory_ids) VALUES ($1,$2,$3,'assistant','A reply',ARRAY[$4]::uuid[])", [messageId, conversationId, owner, created.id]);

    const removed = await memories.DELETE(new Request(`http://test/api/memories?id=${created.id}`, { method: "DELETE" }));
    expect(removed.status).toBe(200);

    // Gone from future retrieval.
    expect(rankMemories(await storedMemories(), "Did he call on Sunday?").map((item) => item.id)).not.toContain(created.id);
    // Gone from the library.
    expect((await list()).body.memories).toHaveLength(0);
    // Still explains an older reply.
    const inspected = await recall.GET(new Request(`http://test/api/messages/${messageId}/recall`), { params: Promise.resolve({ id: messageId }) });
    const body = await inspected.json();
    expect(body.counts.memories).toBe(1);
    expect(body.items[0].available).toBe(true);
    expect(body.items[0].content).toContain("Sunday");
  });

  it("offers an explicit purge for a reader who wants the text gone", async () => {
    const created = await add("Something regrettable.");
    const purged = await memories.DELETE(new Request(`http://test/api/memories?id=${created.id}&purge=1`, { method: "DELETE" }));
    expect((await purged.json()).removed).toBe("deleted");
    expect(await storedMemories()).toHaveLength(0);
  });

  it("shows removed memories only when the library asks for them", async () => {
    const created = await add("A superseded note.");
    await memories.DELETE(new Request(`http://test/api/memories?id=${created.id}`, { method: "DELETE" }));
    expect((await list()).body.memories).toHaveLength(0);
    const withRemoved = await list(`http://test/api/memories?characterId=${characterId}&conversationId=${conversationId}&includeRemoved=1`);
    expect(withRemoved.body.memories).toHaveLength(1);
  });
});

describe("account boundaries", () => {
  it("refuses another account's conversation and never reveals its memories", async () => {
    await add("A private fact.");
    account = { id: stranger, email: null };
    expect((await list()).status).toBe(404);
    const created = (await query("SELECT id FROM memories WHERE user_id=$1", [owner])).rows[0].id;
    expect((await memories.DELETE(new Request(`http://test/api/memories?id=${created}`, { method: "DELETE" }))).status).toBe(404);
    expect((await memories.PATCH(post(`http://test/api/memories?id=${created}`, { content: "rewritten", kind: "event", importance: 3, keywords: [], pinned: false }, "PATCH"))).status).toBe(404);
    account = { id: owner, email: null };
    expect((await storedMemories())[0].content).toBe("A private fact.");
  });

  it("cannot inspect another account's message context", async () => {
    await query("INSERT INTO messages (id,conversation_id,user_id,role,content) VALUES ($1,$2,$3,'assistant','A reply')", [messageId, conversationId, owner]);
    account = { id: stranger, email: null };
    const response = await recall.GET(new Request(`http://test/api/messages/${messageId}/recall`), { params: Promise.resolve({ id: messageId }) });
    expect(response.status).toBe(404);
  });
});

describe("branch lineage", () => {
  it("keeps each story's memories to itself after a branch", async () => {
    const mine = await add("Only in the original story.");
    const branched = await memories.POST(post("http://test/api/memories", { characterId, conversationId: otherConversation, content: "Only in the branch." }));
    expect(branched.status).toBe(201);
    const original = (await list()).body.memories.map((item: { id: string }) => item.id);
    const branch = (await list(`http://test/api/memories?characterId=${characterId}&conversationId=${otherConversation}`)).body.memories.map((item: { content: string }) => item.content);
    expect(original).toContain(mine.id);
    expect(branch).toEqual(["Only in the branch."]);
  });

  it("keeps a creation-wide memory visible from every story", async () => {
    await memories.POST(post("http://test/api/memories", { characterId, conversationId: null, content: "True in every chat with her." }));
    for (const conversation of [conversationId, otherConversation]) {
      const body = (await list(`http://test/api/memories?characterId=${characterId}&conversationId=${conversation}`)).body;
      expect(body.memories.map((item: { content: string }) => item.content)).toContain("True in every chat with her.");
    }
  });
});
