import { describe, expect, it } from "vitest";
import { acceptsResponse, adoptChatView, chatFailed, chatLoaded, clearChatView, emptyChatView, openChatView, type ChatView } from "@/lib/chat-view";
import type { Conversation, Message } from "@/lib/types";

/**
 * Switching chats, including badly.
 *
 * Two reported behaviours are asserted here. The previous story's messages used
 * to stay on screen for a second or two under the new story's name, because
 * selecting a chat set the selection and then awaited a fetch. And nothing
 * ordered the responses, so switching quickly could land an earlier chat on top
 * of the one that was actually clicked.
 */

const story = (id: string, characterId = "char-a"): Conversation => ({ id, characterId, title: id } as unknown as Conversation);
const reply = (id: string, content: string): Message => ({ id, role: "assistant", content } as unknown as Message);

/** Opens a chat and hands back the view plus the request that will answer it. */
function open(view: ChatView, characterId: string, conversationId: string | null) {
  const next = openChatView(view, characterId, conversationId);
  return { view: next, nonce: next.request!.nonce };
}

describe("selecting a chat", () => {
  it("clears the previous story in the same step", () => {
    const showing = chatLoaded(open(emptyChatView, "char-a", "a").view, 1, story("a"), [reply("m1", "A's reply")]);
    expect(showing.messages).toHaveLength(1);

    const switching = openChatView(showing, "char-b", "b");
    // The whole complaint: there is no state in which chat A's replies sit
    // under chat B's header.
    expect(switching.messages).toEqual([]);
    expect(switching.conversation).toBeNull();
    expect(switching.loading).toBe(true);
    expect(switching.request).toMatchObject({ characterId: "char-b", conversationId: "b" });
  });

  it("treats another story with the same creation as a new request", () => {
    // An identifier comparison could not see this, which is why switching
    // stories inside one creation never re-ran the loader.
    const first = open(emptyChatView, "char-a", "a");
    const second = open(first.view, "char-a", "a2");
    expect(second.nonce).toBeGreaterThan(first.nonce);
    expect(second.view.request?.conversationId).toBe("a2");
  });

  it("treats reopening the very same story as a new request too", () => {
    const first = open(emptyChatView, "char-a", "a");
    const again = open(first.view, "char-a", "a");
    expect(again.nonce).toBeGreaterThan(first.nonce);
  });
});

describe("responses land on the chat that asked for them", () => {
  it("A then B: A's answer arriving late is discarded", () => {
    const a = open(emptyChatView, "char-a", "a");
    const b = open(a.view, "char-b", "b");

    const afterLateA = chatLoaded(b.view, a.nonce, story("a"), [reply("m1", "A's reply")]);
    expect(afterLateA.conversation).toBeNull();
    expect(afterLateA.messages).toEqual([]);
    expect(afterLateA.loading).toBe(true);

    const afterB = chatLoaded(afterLateA, b.nonce, story("b", "char-b"), [reply("m2", "B's reply")]);
    expect(afterB.conversation?.id).toBe("b");
    expect(afterB.messages[0].content).toBe("B's reply");
    expect(afterB.loading).toBe(false);
  });

  it("rapid A then B then C, answered C, A, B: C wins", () => {
    const a = open(emptyChatView, "char-a", "a");
    const b = open(a.view, "char-b", "b");
    const c = open(b.view, "char-c", "c");

    let view = chatLoaded(c.view, c.nonce, story("c", "char-c"), [reply("m3", "C's reply")]);
    view = chatLoaded(view, a.nonce, story("a"), [reply("m1", "A's reply")]);
    view = chatLoaded(view, b.nonce, story("b", "char-b"), [reply("m2", "B's reply")]);

    expect(view.conversation?.id).toBe("c");
    expect(view.messages.map((message) => message.content)).toEqual(["C's reply"]);
  });

  it("does not let a superseded failure stop the current chat's spinner", () => {
    const a = open(emptyChatView, "char-a", "a");
    const b = open(a.view, "char-b", "b");
    const afterStaleFailure = chatFailed(b.view, a.nonce);
    expect(afterStaleFailure.loading).toBe(true);
    expect(chatFailed(afterStaleFailure, b.nonce).loading).toBe(false);
  });

  it("knows which request is current", () => {
    const a = open(emptyChatView, "char-a", "a");
    expect(acceptsResponse(a.view, a.nonce)).toBe(true);
    const b = open(a.view, "char-b", "b");
    expect(acceptsResponse(b.view, a.nonce)).toBe(false);
    expect(acceptsResponse(emptyChatView, 1)).toBe(false);
  });
});

describe("a story handed back whole", () => {
  it("shows a new conversation without a second round trip", () => {
    // Creating a chat returns the row and its opening message. Re-reading it
    // would be a round trip for something already in hand, and the delay
    // between the tap and the chat opening is the reported dead click.
    const view = adoptChatView(emptyChatView, "char-a", story("new"), [reply("m0", "The opening.")]);
    expect(view.loading).toBe(false);
    expect(view.conversation?.id).toBe("new");
    expect(view.messages[0].content).toBe("The opening.");
  });

  it("cannot be overwritten by a load that was already in flight", () => {
    const pending = open(emptyChatView, "char-a", "a");
    const adopted = adoptChatView(pending.view, "char-a", story("new"), [reply("m0", "The opening.")]);
    const afterLateLoad = chatLoaded(adopted, pending.nonce, story("a"), [reply("m1", "The old story.")]);
    expect(afterLateLoad.conversation?.id).toBe("new");
  });
});

describe("signing out", () => {
  it("leaves nothing of the previous account on screen", () => {
    const showing = chatLoaded(open(emptyChatView, "char-a", "a").view, 1, story("a"), [reply("m1", "A's reply")]);
    expect(clearChatView()).toEqual(emptyChatView);
    expect(showing.messages).toHaveLength(1);
  });
});
