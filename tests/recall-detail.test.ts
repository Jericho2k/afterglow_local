import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Recalled 6" and six inspectable things.
 *
 * The count came from the ids stored on the reply; the panel resolved those ids
 * against a list the browser had loaded when the CHAT was opened. Consolidation
 * writes new memories after every reply, so a reply that recalled one of them
 * counted six and showed nothing. These assert the property that makes that
 * impossible: the count and the contents are the same array.
 */

const owner = "11111111-1111-4111-8111-111111111111";
const stranger = "22222222-2222-4222-8222-222222222222";
let account: { id: string; email: string | null } | null = { id: owner, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});
vi.mock("@/lib/deepseek", () => ({ streamCompletion: vi.fn(), completionWithUsage: vi.fn(), parseJson: (v: string) => JSON.parse(v) }));

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const recall = await import("@/app/api/messages/[id]/recall/route");

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const messageId = "dddddddd-0000-4000-8000-000000000001";

async function get(id = messageId) {
  const response = await recall.GET(new Request(`http://test/api/messages/${id}/recall`), { params: Promise.resolve({ id }) });
  return { status: response.status, body: await response.json() };
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
  account = { id: owner, email: null };
  vi.stubEnv("AFTERGLOW_ADMIN_USER_IDS", `${owner},${stranger}`);
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title) VALUES ($1,$2,$3,'Story')", [conversationId, owner, characterId]);
});

async function memory(id: string, content: string, conversation: string | null = conversationId) {
  await query(
    "INSERT INTO memories (id,character_id,conversation_id,user_id,content,kind,importance,status) VALUES ($1,$2,$3,$4,$5,'event',3,'active')",
    [id, characterId, conversation, owner, content],
  );
}
async function arc(id: string, summary: string) {
  await query(
    "INSERT INTO memory_arcs (id,conversation_id,user_id,summary,start_message_count,end_message_count) VALUES ($1,$2,$3,$4,1,20)",
    [id, conversationId, owner, summary],
  );
}
async function reply(memoryIds: string[], arcIds: string[]) {
  await query(
    "INSERT INTO messages (id,conversation_id,user_id,role,content,memory_ids,memory_arc_ids) VALUES ($1,$2,$3,'assistant','*She nods.*',$4::uuid[],$5::uuid[])",
    [messageId, conversationId, owner, memoryIds, arcIds],
  );
}

const m1 = "eeeeeeee-0000-4000-8000-000000000001";
const m2 = "eeeeeeee-0000-4000-8000-000000000002";
const a1 = "ffffffff-0000-4000-8000-000000000001";

describe("the count is the contents", () => {
  it("returns one inspectable item for every stored recall id", async () => {
    await memory(m1, "She keeps the map folded in her coat.");
    await memory(m2, "He promised to come back before the frost.", null);
    await arc(a1, "The winter they spent apart.");
    await reply([m1, m2], [a1]);

    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body.counts.total).toBe(3);
    expect(body.items).toHaveLength(3);
    expect(body.items.every((item: { available: boolean }) => item.available)).toBe(true);
    expect(body.counts).toMatchObject({ memories: 2, arcs: 1, unavailable: 0 });
    // Scope is shown, because "this chat" and "all chats" are different facts.
    expect(body.items[0].scope).toBe("chat");
    expect(body.items[1].scope).toBe("creation");
  });

  it("still lists a memory that has since been deleted, rather than dropping it", async () => {
    // This is the exact shape of the reported bug: the reply names an id the
    // archive no longer holds. Dropping it silently is what made six become
    // zero. It is reported as an item so the number always adds up.
    await memory(m1, "She keeps the map folded in her coat.");
    await reply([m1, m2], []);

    const { body } = await get();
    expect(body.counts.total).toBe(2);
    expect(body.items).toHaveLength(2);
    expect(body.counts.unavailable).toBe(1);
    expect(body.items[1]).toEqual({ kind: "memory", id: m2, available: false });
  });

  it("reports an honest zero for a reply that recalled nothing", async () => {
    await reply([], []);
    const { body } = await get();
    expect(body.counts.total).toBe(0);
    expect(body.items).toEqual([]);
  });
});

describe("privacy", () => {
  it("never returns another account's reply", async () => {
    await memory(m1, "She keeps the map folded in her coat.");
    await reply([m1], []);
    account = { id: stranger, email: null };
    expect((await get()).status).toBe(404);
  });

  it("returns nothing about ranking, embeddings or providers", async () => {
    await memory(m1, "She keeps the map folded in her coat.");
    await arc(a1, "The winter they spent apart.");
    await reply([m1], [a1]);
    const serialized = JSON.stringify((await get()).body);
    for (const internal of ["embedding", "score", "similarity", "provider", "retrieval_run", "vector", "weight"]) {
      expect(serialized.toLowerCase()).not.toContain(internal);
    }
  });

  it("is refused for an account without diagnostics access", async () => {
    await reply([], []);
    vi.stubEnv("AFTERGLOW_ADMIN_USER_IDS", "");
    expect((await get()).status).toBe(403);
  });
});
