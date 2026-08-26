import { describe, expect, it } from "vitest";
import { chatHref, commandFromSearch, hrefForRoute, isCurrentHref, isShellView, routeFromSearch, viewHref } from "@/lib/shell-route";

/**
 * Where the shell is, written down.
 *
 * The Back complaint in this sprint was not a Back button bug: it was that a
 * chat had no address, so the entry underneath a creation page opened from a
 * chat named Chats or Discovery and Back honestly went there. These assert the
 * record, because the record is the fix.
 */

describe("a chat is a route", () => {
  it("names the character and the exact story", () => {
    expect(chatHref("char-1", "conv-9")).toBe("/?view=chat&character=char-1&conversation=conv-9");
    expect(routeFromSearch("?view=chat&character=char-1&conversation=conv-9"))
      .toEqual({ view: "chat", characterId: "char-1", conversationId: "conv-9" });
  });

  it("round-trips through href and back without losing the story", () => {
    const route = { view: "chat", characterId: "char-1", conversationId: "conv-9" } as const;
    expect(routeFromSearch(new URL(`http://x${hrefForRoute(route)}`).search)).toEqual(route);
  });

  it("survives a creation page opening a chat with the older link shape", () => {
    // What `/characters/[id]`'s Chat button pushes. It used to be rewritten to
    // "/", which is precisely what deleted the chat from history.
    expect(routeFromSearch("?character=char-1&conversation=conv-9"))
      .toEqual({ view: "chat", characterId: "char-1", conversationId: "conv-9" });
  });

  it("opens the newest story when a link names only the creation", () => {
    expect(routeFromSearch("?view=chat&character=char-1"))
      .toEqual({ view: "chat", characterId: "char-1", conversationId: null });
  });
});

describe("shell views", () => {
  it("keeps every named surface addressable", () => {
    for (const view of ["home", "chats", "worlds", "personas", "profile", "saved", "creations"] as const) {
      expect(routeFromSearch(new URL(`http://x${viewHref(view)}`).search)).toEqual({ view });
    }
  });

  it("still understands the name Saved used to have", () => {
    expect(routeFromSearch("?view=likes")).toEqual({ view: "saved" });
  });

  it("treats a bare address as Home", () => {
    expect(routeFromSearch("")).toEqual({ view: "home" });
  });

  it("refuses to invent a surface for an unknown view", () => {
    expect(isShellView("nonsense")).toBe(false);
    expect(routeFromSearch("?view=nonsense")).toBeNull();
  });

  it("leaves a command-only address showing whatever is already open", () => {
    // Returning null rather than "home" is what stops a reader who opened the
    // studio from a deep link being bounced to Discovery behind it.
    expect(routeFromSearch("?create=1")).toBeNull();
    expect(routeFromSearch("?editWorld=w1")).toBeNull();
    expect(routeFromSearch("?editCharacter=c1")).toBeNull();
  });
});

describe("commands are separate from routes", () => {
  it("recognises each one exactly once", () => {
    expect(commandFromSearch("?create=1")).toEqual({ kind: "createCreation" });
    expect(commandFromSearch("?editCharacter=c1")).toEqual({ kind: "editCreation", characterId: "c1" });
    expect(commandFromSearch("?editWorld=w1")).toEqual({ kind: "editWorld", worldId: "w1" });
    expect(commandFromSearch("?verification=success")).toEqual({ kind: "verified" });
    expect(commandFromSearch("?view=chats")).toBeNull();
  });

  it("does not read a chat as a command", () => {
    expect(commandFromSearch(chatHref("char-1", "conv-9").slice(1))).toBeNull();
  });
});

describe("history hygiene", () => {
  it("recognises the entry it is already standing on", () => {
    expect(isCurrentHref({ pathname: "/", search: "?view=chats" }, "/?view=chats")).toBe(true);
    expect(isCurrentHref({ pathname: "/", search: "" }, "/")).toBe(true);
    expect(isCurrentHref({ pathname: "/", search: "?view=chats" }, "/?view=saved")).toBe(false);
  });

  it("distinguishes two stories with the same creation", () => {
    expect(isCurrentHref({ pathname: "/", search: new URL(`http://x${chatHref("c", "a")}`).search }, chatHref("c", "b"))).toBe(false);
  });
});
