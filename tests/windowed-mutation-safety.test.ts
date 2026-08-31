import type { Pool } from "pg";
import { newDb } from "pg-mem";
import { beforeEach, describe, expect, it } from "vitest";

// Seeding and scanning four hundred rows through pg-mem is slower than the
// default per-test budget, and the story has to be this long for the bug to
// exist at all.
const LONG_STORY_TIMEOUT = 60_000;
import { ensureSchema, query, setPoolForTesting, transaction } from "@/lib/db";
import { messageFingerprint } from "@/lib/message-identity";
import { deleteMessagesFromPosition, lockMessageForMutation, persistedMessagePosition } from "@/lib/message-mutations";
import { chatLoaded, emptyChatView, openChatView, prependedMessages } from "@/lib/chat-view";
import type { Conversation, Message } from "@/lib/types";

/**
 * THE BUG THIS FILE EXISTS FOR.
 *
 * Opening a chat stopped returning the whole story and started returning a
 * window of its newest messages. Nothing told the client that the indices it
 * renders from were no longer positions in the conversation, so "delete from
 * here" on the fifth message ON SCREEN sent position 5 — and the server, which
 * counts from the beginning of the STORY, found the fifth message ever written.
 * In a four hundred message story that is the difference between removing three
 * replies and removing three hundred and ninety five.
 *
 * The window is 120 by default, so the smallest story that can show it is
 * larger than that. These use 400.
 */

const ownerId = "11111111-1111-4111-8111-111111111111";
const LONG_STORY = 400;

let characterId = "";
let conversationId = "";
let messageIds: string[] = [];

beforeEach(async () => {
  const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = memoryDb.adapters.createPg();
  setPoolForTesting(new adapter.Pool() as unknown as Pool);
  await ensureSchema();

  characterId = crypto.randomUUID();
  conversationId = crypto.randomUUID();
  await query("INSERT INTO characters (id,name,user_id) VALUES ($1,'Mara',$2)",[characterId,ownerId]);
  await query("INSERT INTO conversations (id,character_id,user_id,title,message_count) VALUES ($1,$2,$3,'A long story',$4)",[conversationId,characterId,ownerId,LONG_STORY]);
  messageIds = [];
  for (let index = 0; index < LONG_STORY; index += 1) {
    const id = crypto.randomUUID();
    messageIds.push(id);
    await query(
      "INSERT INTO messages (id,conversation_id,user_id,role,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)",
      [id,conversationId,ownerId,index % 2 === 0 ? "user" : "assistant",`Message ${index + 1}`,new Date(Date.UTC(2026,0,1,0,0,index)).toISOString()],
    );
  }
}, LONG_STORY_TIMEOUT);

/** What the client would send for a message at `localIndex` inside a window. */
async function locatorFor(windowStartPosition: number, localIndex: number, role: string, content: string) {
  return {
    conversationId,
    messagePosition: windowStartPosition + localIndex + 1,
    messageFingerprint: await messageFingerprint(role, content),
    userId: ownerId,
  };
}

describe("mutating a message inside a windowed transcript", () => {
  it("resolves a window-relative index to the message the reader is looking at", async () => {
    // The last 120 of 400: the window starts 280 messages into the story.
    const windowStart = LONG_STORY - 120;
    const localIndex = 4;
    const intended = messageIds[windowStart + localIndex];

    const locator = await locatorFor(windowStart, localIndex, "user", `Message ${windowStart + localIndex + 1}`);
    const lock = await transaction((client) => lockMessageForMutation(client, crypto.randomUUID(), locator));

    expect(lock.ok).toBe(true);
    expect(lock.ok && String(lock.row.id)).toBe(intended);
    // And emphatically NOT the fifth message ever written, which is what the
    // window-relative position used to resolve to.
    expect(lock.ok && String(lock.row.id)).not.toBe(messageIds[localIndex]);
  }, LONG_STORY_TIMEOUT);

  it("deletes only the intended suffix of a long story", async () => {
    const windowStart = LONG_STORY - 120;
    const localIndex = 117; // third from the end of the window, and of the story
    const absolute = windowStart + localIndex + 1;

    const locator = await locatorFor(windowStart, localIndex, "assistant", `Message ${absolute}`);
    const lock = await transaction((client) => lockMessageForMutation(client, crypto.randomUUID(), locator));
    expect(lock.ok).toBe(true);
    if (!lock.ok) return;

    const position = await transaction((client) => persistedMessagePosition(client, conversationId, String(lock.row.id)));
    expect(position).toBe(absolute);
    await transaction((client) => deleteMessagesFromPosition(client, conversationId, position, ownerId));

    const remaining = (await query<{ id: string }>("SELECT id FROM messages WHERE conversation_id=$1 ORDER BY created_at,id",[conversationId])).rows.map((row) => row.id);
    expect(remaining).toEqual(messageIds.slice(0, absolute - 1));
    expect(remaining).toHaveLength(LONG_STORY - 3);
  }, LONG_STORY_TIMEOUT);

  it("refuses rather than deleting the wrong three hundred messages", async () => {
    // Exactly the old bug: a window-relative index sent as if it were absolute.
    const localIndex = 4;
    const onScreen = messageIds[LONG_STORY - 120 + localIndex];
    const staleLocator = {
      conversationId,
      messagePosition: localIndex + 1,
      messageFingerprint: await messageFingerprint("user", `Message ${LONG_STORY - 120 + localIndex + 1}`),
      userId: ownerId,
    };

    const lock = await transaction((client) => lockMessageForMutation(client, crypto.randomUUID(), staleLocator));
    expect(lock).toEqual({ ok: false, reason: "unverified" });
    expect(onScreen).toBeTruthy();

    // Nothing was written, and nothing was deleted.
    const count = Number((await query("SELECT COUNT(*) count FROM messages WHERE conversation_id=$1",[conversationId])).rows[0].count);
    expect(count).toBe(LONG_STORY);
  }, LONG_STORY_TIMEOUT);

  it("refuses an out-of-window position with no proof attached", async () => {
    const lock = await transaction((client) => lockMessageForMutation(client, crypto.randomUUID(), {
      conversationId, messagePosition: 7, userId: ownerId,
    }));
    expect(lock).toEqual({ ok: false, reason: "unverified" });
  }, LONG_STORY_TIMEOUT);

  it("reports a genuinely absent message as missing, not as unproven", async () => {
    const beyondEnd = {
      conversationId, messagePosition: LONG_STORY + 50, userId: ownerId,
      messageFingerprint: await messageFingerprint("user","Message 1"),
    };
    const lock = await transaction((client) => lockMessageForMutation(client, crypto.randomUUID(), beyondEnd));
    expect(lock).toEqual({ ok: false, reason: "missing" });
  }, LONG_STORY_TIMEOUT);
});

describe("the window offset the client mutates from", () => {
  const conversation = { id: "c", characterId: "x" } as unknown as Conversation;
  const message = (id: string) => ({ id, conversationId: "c", role: "user", content: id, variants: [], selectedVariant: 0, memoryIds: [], arcIds: [], createdAt: "2026-01-01T00:00:00Z" }) as Message;

  it("carries the server's offset onto the view a mutation reads", () => {
    const opened = openChatView(emptyChatView, "x", "c");
    const loaded = chatLoaded(opened, opened.request!.nonce, conversation, [message("a"), message("b")], true, 280);
    expect(loaded.windowStartPosition).toBe(280);
    // Which is what turns local index 1 into conversation position 282.
    expect(loaded.windowStartPosition + 1 + 1).toBe(282);
  });

  it("moves the offset back up the story when earlier messages are loaded", () => {
    const opened = openChatView(emptyChatView, "x", "c");
    const loaded = chatLoaded(opened, opened.request!.nonce, conversation, [message("c1")], true, 280);
    const earlier = prependedMessages(loaded, "c", [message("b1"), message("b2")], true, 278);
    expect(earlier.windowStartPosition).toBe(278);
    expect(earlier.messages.map((item) => item.id)).toEqual(["b1","b2","c1"]);
  });

  it("falls back to counting the splice when the server sends no offset", () => {
    const opened = openChatView(emptyChatView, "x", "c");
    const loaded = chatLoaded(opened, opened.request!.nonce, conversation, [message("c1")], true, 5);
    const earlier = prependedMessages(loaded, "c", [message("b1"), message("b2")], false);
    expect(earlier.windowStartPosition).toBe(3);
  });

  it("starts at zero when the whole story is on screen", () => {
    const opened = openChatView(emptyChatView, "x", "c");
    const loaded = chatLoaded(opened, opened.request!.nonce, conversation, [message("a")], false);
    expect(loaded.windowStartPosition).toBe(0);
  });
});
