import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatFailed, chatLoaded, emptyChatView, openChatView, showsRoute, type ChatView } from "@/lib/chat-view";
import type { Conversation, Message } from "@/lib/types";

/**
 * BACK, OUT OF A CREATION PAGE, INTO THE CHAT YOU CAME FROM.
 *
 * The reported sequence is: open a chat, tap its title to read the creation,
 * press Back — and the transition looks broken, sometimes the chat fails to
 * load, sometimes it shows an error. None of that is an animation problem.
 *
 * Back fires `popstate`. The shell reads the address, and the address says
 * "chat with creation X, story Y" — which is exactly what is already on screen.
 * Applying it as a navigation cleared the transcript, bumped the request nonce
 * and set `loading`, so the reader watched a conversation they had just left
 * blank itself and rebuild over a network round trip, with a second identical
 * request racing the first and either of them able to raise an error banner.
 *
 * The distinction is "is this address a different place", and it is a pure
 * question about the view, which is why it is answerable here.
 */

const story = (id: string, characterId = "char-a"): Conversation => ({ id, characterId, title: id } as unknown as Conversation);
const reply = (id: string, content: string): Message => ({ id, role: "assistant", content } as unknown as Message);

/** A view showing one loaded story, the way the shell holds it. */
function showing(characterId: string, conversationId: string): ChatView {
  const opened = openChatView(emptyChatView, characterId, conversationId);
  return chatLoaded(opened, opened.request!.nonce, story(conversationId, characterId), [reply("m1", "A reply.")]);
}

describe("an address that names the story already open", () => {
  it("is not a navigation", () => {
    expect(showsRoute(showing("char-a", "a"), "char-a", "a")).toBe(true);
  });

  it("is not a navigation while that story is still loading either", () => {
    // Back pressed during the first load must not start a second one.
    expect(showsRoute(openChatView(emptyChatView, "char-a", "a"), "char-a", "a")).toBe(true);
  });

  it("matches a story that was opened without naming one", () => {
    // The creation page pushes `?character=…` with no conversation when the
    // reader has no story yet; the shell resolves one and the address is
    // canonicalised afterwards. Both spellings name the same place.
    const opened = openChatView(emptyChatView, "char-a", null);
    const loaded = chatLoaded(opened, opened.request!.nonce, story("a"), []);
    expect(showsRoute(loaded, "char-a", "a")).toBe(true);
    expect(showsRoute(loaded, "char-a", null)).toBe(true);
  });
});

describe("an address that names somewhere else", () => {
  it("is a navigation, so the chat is re-opened", () => {
    expect(showsRoute(showing("char-a", "a"), "char-b", "b")).toBe(false);
  });

  it("is a navigation for another story with the SAME creation", () => {
    // The case an id comparison on the creation alone cannot see.
    expect(showsRoute(showing("char-a", "a"), "char-a", "b")).toBe(false);
  });

  it("is a navigation when the view is showing nothing at all", () => {
    expect(showsRoute(emptyChatView, "char-a", "a")).toBe(false);
  });

  it("is a navigation after a load failed, so Back can recover it", () => {
    const opened = openChatView(emptyChatView, "char-a", "a");
    const failed = chatFailed(opened, opened.request!.nonce);
    // Nothing on screen and nothing in flight: re-asking is the right answer,
    // and is how a chat that failed to open recovers without a full reload.
    expect(showsRoute(failed, "char-a", "a")).toBe(false);
  });
});

/**
 * The rules above only matter if the shell actually applies them, and the two
 * other halves of this regression are in code a unit test cannot mount. They
 * are asserted against the source, which is the same technique the rest of the
 * suite uses for the creation page's navigation.
 */
describe("the shell applies them", () => {
  const shell = readFileSync(new URL("../src/components/shell/AppShell.tsx", import.meta.url), "utf8");

  it("asks before re-opening a chat from the address bar", () => {
    const applyRoute = shell.slice(shell.indexOf("const applyRoute=useCallback"), shell.indexOf("const goToView=useCallback"));
    expect(applyRoute).toContain("showsRoute(chatViewRef.current");
    // And it returns before `selectChat`, which is what clears the transcript.
    expect(applyRoute.indexOf("showsRoute")).toBeLessThan(applyRoute.indexOf("selectChat("));
  });

  it("never raises an error from inside a state updater", () => {
    /*
     * `setError` inside a `setChatView` updater runs during render and may run
     * twice, so a stale failure could raise a banner over a chat that had
     * loaded perfectly well. The nonce check now happens against the ref,
     * before anything is set.
     */
    const loader = shell.slice(shell.indexOf("const openOrStart = async ()"), shell.indexOf("// A different story has a different set"));
    expect(loader).toContain("acceptsResponse(chatViewRef.current, nonce)");
    expect(loader).not.toMatch(/setChatView\(\(view\) => \{[\s\S]*setError\(/);
  });

  it("does not let a finished generation write into a story the reader has left", () => {
    const send = shell.slice(shell.indexOf("async function send("), shell.indexOf("const adoptConversation"));
    // Deltas, the completion bookkeeping and the failure path are all scoped to
    // the conversation the turn belongs to.
    expect(send.match(/chatViewRef\.current\.conversation\?\.id/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("does not let a refresh land on a different story of the same creation", () => {
    const refresh = shell.slice(shell.indexOf("const refreshChat = useCallback"), shell.indexOf("const loadEarlier = useCallback"));
    expect(refresh).toContain("refreshed !== open");
  });
});

/**
 * Both standalone pages restore what the reader had already been shown, rather
 * than blanking and re-fetching. That is the "black page with empty elements"
 * on Back out of a cast member, and it is a data-lifetime problem rather than a
 * paint one: the component is unmounted by the router, so its state goes with
 * it.
 */
describe("returning to a page you have already read", () => {
  /*
   * The creation page's store moved into `src/lib/creation-cache.ts` so that a
   * save can DELETE an entry: returning from the editor remounts this page, and
   * an entry written before the edit would be painted in the first frame. The
   * cast member's page still owns its own, because nothing else has a reason to
   * invalidate it. So the store is named separately from the page that reads
   * it, and the assertions below follow it rather than assuming both live in
   * the component.
   */
  for (const [label, path, store] of [
    ["the creation page", "../src/app/characters/[id]/profile.tsx", "../src/lib/creation-cache.ts"],
    ["a cast member's page", "../src/app/characters/[id]/cast/[memberId]/profile.tsx", "../src/app/characters/[id]/cast/[memberId]/profile.tsx"],
  ] as const) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const cache = readFileSync(new URL(store, import.meta.url), "utf8");

    it(`${label} paints from what it already had`, () => {
      expect(source).toMatch(/(Cache\.get\(|readCreation<)/);
      expect(source).toMatch(/if \(cached\)/);
    });

    it(`${label} cancels a fetch it no longer needs`, () => {
      expect(source).toContain("new AbortController()");
      expect(source).toContain("controller.abort()");
      expect(source).toContain("signal: controller.signal");
    });

    it(`${label} does not let an aborted request become an error`, () => {
      expect(source).toContain("if (stopped()");
    });

    it(`${label} bounds what it remembers`, () => {
      expect(cache).toMatch(/CacheLimit = \d+/);
      expect(cache).toMatch(/\.delete\(oldest\)/);
    });
  }

  it("does not defer a cast portrait until the reader scrolls", () => {
    /*
     * A `loading="lazy"` image is evaluated against the viewport as the page
     * lays out, and a restored page lays out at scroll 0 and is scrolled
     * afterwards — so portraits below the fold at that instant were never
     * re-evaluated and stayed blank until the reader nudged the screen. The
     * gallery keeps lazy loading, because full-size uploads far below the fold
     * are what it is for.
     */
    const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");
    const castAvatar = page.slice(page.indexOf("styles.castAvatar}>"), page.indexOf("styles.castCopy}"));
    expect(castAvatar).toContain('decoding="async"');
    expect(castAvatar).not.toContain('loading="lazy"');
  });
});
