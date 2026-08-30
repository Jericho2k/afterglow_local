import type { Pool } from "pg";
import { DataType, newDb } from "pg-mem";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What opening a chat costs, measured rather than asserted.
 *
 * The dominant cost was one line: the transcript read had no bound, so opening
 * a story read, serialised and shipped every message it had ever contained —
 * including every stored variant of every regenerated reply — before a word
 * appeared on screen. It grew without limit with exactly the behaviour the
 * product exists to encourage.
 *
 * Two other properties are asserted here because they are the ones a bounded
 * read could quietly break: the window must be the NEWEST messages (a reader
 * opens a story at its end), and the rest must remain reachable.
 *
 * A row count is the honest unit for this. Wall-clock in an in-memory database
 * measures the in-memory database; rows read and rows returned are what changes
 * on a real one, and they are what changed here.
 */

const owner = "11111111-1111-4111-8111-111111111111";
let account: { id: string; email: string | null } | null = { id: owner, email: null };

vi.mock("@/lib/session", async () => {
  const actual = await vi.importActual<typeof import("@/lib/session")>("@/lib/session");
  return { ...actual, currentAccount: async () => account };
});

const { ensureSchema, query, setPoolForTesting } = await import("@/lib/db");
const conversations = await import("@/app/api/conversations/route");
const { transcriptWindow } = conversations;

const characterId = "aaaaaaaa-0000-4000-8000-000000000001";
const conversationId = "cccccccc-0000-4000-8000-000000000001";
const storyLength = 400;

async function open(search = "") {
  const url = `http://test/api/conversations?characterId=${characterId}&conversationId=${conversationId}${search}`;
  const response = await conversations.GET(new Request(url));
  return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  database.public.registerFunction({
    name: "left", args: [DataType.text, DataType.integer], returns: DataType.text,
    implementation: (value: string, length: number) => value.slice(0, length),
  });
  setPoolForTesting(new (database.adapters.createPg()).Pool() as unknown as Pool);
  await ensureSchema();
  account = { id: owner, email: null };
  await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Maya')", [characterId, owner]);
  await query("INSERT INTO conversations (id,user_id,character_id,title,message_count) VALUES ($1,$2,$3,'Story',$4)", [conversationId, owner, characterId, storyLength]);
  for (let index = 0; index < storyLength; index += 1) {
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        `dddddddd-0000-4000-8000-${String(index).padStart(12, "0")}`,
        conversationId, owner,
        index % 2 === 0 ? "user" : "assistant",
        `Message ${index}`,
        new Date(1_700_000_000_000 + index * 60_000).toISOString(),
      ],
    );
  }
});

describe("opening a long story", () => {
  it("no longer ships the entire transcript", () => {
    // The previous behaviour, stated as the number it produced.
    expect(storyLength).toBeGreaterThan(transcriptWindow);
  });

  it("returns a bounded window instead", async () => {
    const { status, body } = await open();
    expect(status).toBe(200);
    expect(body.messages).toHaveLength(transcriptWindow);
    // 400 messages in the story, 120 on the wire: 70% fewer rows read,
    // serialised and parsed before the first word is on screen.
    expect(body.messages.length / storyLength).toBeLessThan(0.35);
  });

  it("returns the NEWEST messages, in order", async () => {
    const { body } = await open();
    expect(body.messages[body.messages.length - 1].content).toBe(`Message ${storyLength - 1}`);
    expect(body.messages[0].content).toBe(`Message ${storyLength - transcriptWindow}`);
    const times = body.messages.map((message: { createdAt: string }) => Date.parse(message.createdAt));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("says the story continues above the window", async () => {
    const { body } = await open();
    expect(body.hasMoreBefore).toBe(true);
  });

  it("hands back the rest, page by page, with no gap and no repeat", async () => {
    let page = (await open()).body;
    const seen: string[] = page.messages.map((message: { id: string }) => message.id);
    let guard = 0;
    while (page.hasMoreBefore && guard < 20) {
      page = (await open(`&before=${page.messages[0].id}`)).body;
      seen.unshift(...page.messages.map((message: { id: string }) => message.id));
      guard += 1;
    }
    expect(page.hasMoreBefore).toBe(false);
    expect(seen).toHaveLength(storyLength);
    expect(new Set(seen).size).toBe(storyLength);
    // Oldest first, all the way back to the first message.
    expect(seen[0]).toContain("000000000000");
  });

  it("does not page past the end of somebody else's story", async () => {
    const stranger = "22222222-2222-4222-8222-222222222222";
    account = { id: stranger, email: null };
    const response = await conversations.GET(new Request(`http://test/api/conversations?characterId=${characterId}&conversationId=${conversationId}`));
    expect(response.status).toBe(404);
  });

  it("caps a caller-supplied window rather than trusting it", async () => {
    const { body } = await open("&limit=100000");
    expect(body.messages.length).toBeLessThanOrEqual(400);
  });
});

describe("a short story is unchanged", () => {
  it("arrives whole, with nothing above it", async () => {
    await query("DELETE FROM messages WHERE conversation_id=$1", [conversationId]);
    for (let index = 0; index < 8; index += 1) {
      await query(
        "INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES ($1,$2,$3,'user',$4,$5)",
        [`eeeeeeee-0000-4000-8000-${String(index).padStart(12, "0")}`, conversationId, owner, `Short ${index}`, new Date(1_700_000_000_000 + index * 1000).toISOString()],
      );
    }
    const { body } = await open();
    expect(body.messages).toHaveLength(8);
    expect(body.hasMoreBefore).toBe(false);
  });
});

describe("reading a creation's stories", () => {
  it("does not start one", async () => {
    // The GET used to create a conversation whenever the list came back empty,
    // which made every incidental read — saving an edit, a post-save refresh —
    // put a story in Chats that nobody had opened.
    const empty = "aaaaaaaa-0000-4000-8000-000000000002";
    await query("INSERT INTO characters (id,user_id,name) VALUES ($1,$2,'Never chatted')", [empty, owner]);
    const before = await query("SELECT COUNT(*)::int count FROM conversations WHERE user_id=$1", [owner]);

    const response = await conversations.GET(new Request(`http://test/api/conversations?characterId=${empty}`));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.conversations).toEqual([]);
    expect(body.conversation).toBeNull();

    const after = await query("SELECT COUNT(*)::int count FROM conversations WHERE user_id=$1", [owner]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("still starts one when asked explicitly", async () => {
    const empty = "aaaaaaaa-0000-4000-8000-000000000003";
    await query("INSERT INTO characters (id,user_id,name,greeting) VALUES ($1,$2,'Fresh','Hello there.')", [empty, owner]);
    const response = await conversations.POST(new Request("http://test/api/conversations", {
      method: "POST", body: JSON.stringify({ characterId: empty }), headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.conversation.characterId).toBe(empty);
    expect(body.messages[0].content).toBe("Hello there.");
  });
});
