import { describe, expect, it } from "vitest";
import {
  backFallbacks, canGoBack, claimDepth, currentDepth, navigationDepthKey, nextDepth,
  readLastDepth, resolveBack, rootDepth, stampedDepth, takeClaimedDepth, withDepth, writeLastDepth,
} from "@/lib/back-navigation";

/**
 * Back returns to the page the reader came from.
 *
 * These drive a small model of a browser tab — a stack of history entries, each
 * with its own state object — through `NavigationTracker`'s exact logic, and
 * then ask `BackButton`'s question of the result. So the journeys below are the
 * real ones: Discovery to a creation and back, a search to a creation and back
 * into the same search, a creation to its world and back, and a link opened
 * cold with nothing of ours behind it.
 */

type Entry = { url: string; state: unknown };

function tab({ external = 0 } = {}) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  // Pages from other sites the reader visited in this tab before arriving.
  // They are real history entries that Back must never step out onto.
  const entries: Entry[] = Array.from({ length: external }, (_, index) => ({ url: `https://elsewhere.example/${index}`, state: null }));
  let index = entries.length - 1;

  /** Exactly what NavigationTracker does on every route change. */
  function track() {
    const entry = entries[index];
    const existing = stampedDepth(entry.state);
    if (existing !== null) { writeLastDepth(storage, existing); return; }
    const depth = takeClaimedDepth(storage) ?? nextDepth(readLastDepth(storage));
    entry.state = withDepth(entry.state, depth);
    writeLastDepth(storage, depth);
  }

  return {
    storage,
    /** A router push: a new entry on top of wherever we are. */
    visit(url: string) {
      entries.length = index + 1;
      entries.push({ url, state: null });
      index += 1;
      track();
      return this;
    },
    /** A router replace, or the feed rewriting its query in place. */
    replace(url: string, { keepState = true } = {}) {
      entries[index] = { url, state: keepState ? entries[index].state : null };
      track();
      return this;
    },
    /** A reload: the entry and its state persist, the tracker runs again. */
    reload() { track(); return this; },
    back() {
      if (index === 0) return false;
      index -= 1;
      track();
      return true;
    },
    forward() {
      if (index >= entries.length - 1) return false;
      index += 1;
      track();
      return true;
    },
    url() { return entries[index].url; },
    depth() { return currentDepth(entries[index].state, storage); },
    /** What the Back control decides on this page right now. */
    press(fallback: string) { return resolveBack(this.depth(), fallback); },
  };
}

describe("Discovery → Creation → Back", () => {
  it("returns through history rather than to a hard-coded route", () => {
    const session = tab().visit("/").visit("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
  });

  it("lands on Discovery, which then has nothing of ours below it", () => {
    const session = tab().visit("/").visit("/characters/aaaa");
    session.back();
    expect(session.url()).toBe("/");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });
});

describe("Search results → Creation → Back", () => {
  it("returns to the search rather than to an unfiltered feed", () => {
    const session = tab().visit("/?q=poetry&tags=Romance").visit("/characters/aaaa");
    // History, not a route we composed: only the browser's own entry still
    // carries the query the feed restores its results and scroll from.
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/?q=poetry&tags=Romance");
  });

  it("is unmoved by the feed rewriting its own query in place", () => {
    const session = tab().visit("/");
    // The feed mirrors each filter change into the address bar with a replace
    // that carries the existing history state forward.
    session.replace("/?tags=Romance").replace("/?tags=Romance,Drama");
    expect(session.depth()).toBe(rootDepth);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });

    // And the rewritten query is what a creation opened from it comes back to.
    session.visit("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/?tags=Romance,Drama");
  });
});

describe("Creation → World → Back", () => {
  it("returns to the creation the world was opened from", () => {
    const session = tab().visit("/").visit("/characters/aaaa").visit("/worlds/bbbb");
    expect(session.press(backFallbacks.world)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/characters/aaaa");
    // And Back again continues to Discovery rather than to the world.
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/");
  });
});

describe("Worlds → World → Back", () => {
  it("returns to the Worlds page", () => {
    const session = tab().visit("/?view=worlds").visit("/worlds/bbbb");
    expect(session.press(backFallbacks.world)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/?view=worlds");
  });

  it("falls back to Worlds, not to Discovery, for a world opened cold", () => {
    const session = tab().visit("/worlds/bbbb");
    expect(session.press(backFallbacks.world)).toEqual({ type: "fallback", href: "/?view=worlds" });
  });
});

describe("Creator profile → Creation → Back", () => {
  it("returns to the creator profile, which is a query-string view of the shell", () => {
    const session = tab().visit("/").visit("/?view=creator&creator=nova").visit("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/?view=creator&creator=nova");
    // The profile itself still has Discovery underneath it.
    expect(canGoBack(session.depth())).toBe(true);
  });
});

/**
 * Your Creations → Edit → Back.
 *
 * Editing used to be a server redirect into the home shell with the creation's
 * id in a query string, so Back from the studio returned to Home rather than
 * to the list the reader pressed Edit in. It is now a page of its own, which
 * is what makes this an ordinary history step.
 */
describe("Your Creations → Edit → Back", () => {
  it("returns to the management list rather than to Home", () => {
    const session = tab().visit("/?view=creations").visit("/characters/aaaa/edit");
    expect(session.press("/characters/aaaa")).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/?view=creations");
  });

  it("returns to the creation when Edit was pressed on the creation page", () => {
    const session = tab().visit("/").visit("/characters/aaaa").visit("/characters/aaaa/edit");
    expect(session.press("/characters/aaaa")).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/characters/aaaa");
    // And once more, back to where the creation was opened from.
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/");
  });

  it("falls back to the creation itself for an edit page opened cold", () => {
    const session = tab().visit("/characters/aaaa/edit");
    expect(session.press("/characters/aaaa")).toEqual({ type: "fallback", href: "/characters/aaaa" });
  });

  it("treats a deletion's replacement as the tab's new root", () => {
    // There is nothing to go back to once the creation is gone, so the
    // management list replaces the edit entry rather than stacking on it.
    const session = tab().visit("/?view=creations").visit("/characters/aaaa/edit");
    claimDepth(session.storage, rootDepth);
    session.replace(backFallbacks.creations, { keepState: false });
    expect(session.depth()).toBe(rootDepth);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: backFallbacks.creation });
  });
});

/**
 * Clearing a query string must not clear the navigation stamp with it.
 *
 * The home shell tidies its own URL after acting on a deep link. It used to do
 * that with an empty state object, which erased the depth stamp on the entry —
 * and every Back control on pages opened from there then fell through to its
 * fallback instead of returning to the previous page.
 */
describe("the shell tidying its own URL", () => {
  it("keeps the depth when it rewrites the query away", () => {
    const session = tab().visit("/").visit("/?character=aaaa&conversation=bbbb");
    const before = session.depth();
    session.replace("/");
    expect(session.depth()).toBe(before);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
  });

  it("would have broken Back had the state been discarded", () => {
    // The regression, stated directly: a replace that drops history state
    // makes the entry look like the tab's root.
    const session = tab().visit("/").visit("/?character=aaaa");
    session.replace("/", { keepState: false });
    // The tracker restamps it, but from the last depth it saw rather than from
    // nothing — which is why the fallback path is reached only when the stamp
    // and the recorded depth are both gone.
    expect(session.depth()).toBeGreaterThan(rootDepth);
  });
});

/**
 * Discovery → Your Creations → Back.
 *
 * The management page is a query-string view of the shell, exactly as Worlds
 * and Saved are, so moving into it is an ordinary history step and Back is an
 * ordinary return.
 */
describe("Discovery → Your Creations → Back", () => {
  it("returns to Discovery", () => {
    const session = tab().visit("/").visit("/?view=creations");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/");
  });

  it("falls back to Discovery for a management page opened cold", () => {
    const session = tab().visit("/?view=creations");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });
});

describe("deep links", () => {
  it("gives a creation opened cold a safe in-app destination", () => {
    const session = tab().visit("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });

  it("does not step out of the app onto the site the reader arrived from", () => {
    // Two entries from another origin sit below this one, so history exists —
    // but none of it is ours, and Back must not walk onto it.
    const session = tab({ external: 2 }).visit("/characters/aaaa");
    expect(session.depth()).toBe(rootDepth);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });

  it("uses history once the reader has moved inside the app from the deep link", () => {
    const session = tab({ external: 1 }).visit("/characters/aaaa").visit("/worlds/bbbb");
    expect(session.press(backFallbacks.world)).toEqual({ type: "history" });
    session.back();
    expect(session.url()).toBe("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });

  it("falls back rather than doing nothing when storage and history state are unavailable", () => {
    expect(resolveBack(currentDepth(null, null), backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
    expect(() => writeLastDepth(null, 3)).not.toThrow();
    expect(() => claimDepth(null, 0)).not.toThrow();
    expect(takeClaimedDepth(null)).toBeNull();
  });
});

describe("history stays consistent under real use", () => {
  it("survives a reload without inventing history or losing it", () => {
    const session = tab().visit("/").visit("/characters/aaaa");
    session.reload().reload();
    expect(session.depth()).toBe(1);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "history" });
  });

  it("keeps the same answer when the reader goes back and forward repeatedly", () => {
    const session = tab().visit("/").visit("/characters/aaaa").visit("/worlds/bbbb");
    for (let round = 0; round < 3; round += 1) {
      session.back();
      expect(session.depth()).toBe(1);
      session.back();
      expect(session.depth()).toBe(rootDepth);
      expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
      session.forward();
      session.forward();
      expect(session.depth()).toBe(2);
    }
  });

  it("does not deepen when a page is opened from a page at the same depth", () => {
    const first = tab().visit("/").visit("/characters/aaaa");
    first.back();
    const second = first.visit("/characters/bbbb");
    // Replacing the forward entry rather than stacking on it: still one deep.
    expect(second.depth()).toBe(1);
    expect(second.press(backFallbacks.creation)).toEqual({ type: "history" });
  });

  it("treats the fallback as the tab's new root, so Back there does not bounce", () => {
    const session = tab().visit("/characters/aaaa");
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
    // BackButton claims the root depth before replacing, which the tracker
    // then honours for the entry the replace creates.
    claimDepth(session.storage, rootDepth);
    session.replace("/", { keepState: false });
    expect(session.depth()).toBe(rootDepth);
    expect(session.press(backFallbacks.creation)).toEqual({ type: "fallback", href: "/" });
  });
});

describe("the depth stamp itself", () => {
  it("reads only a real, non-negative integer stamp", () => {
    expect(stampedDepth(null)).toBeNull();
    expect(stampedDepth({})).toBeNull();
    expect(stampedDepth("2")).toBeNull();
    expect(stampedDepth({ afterglowDepth: "2" })).toBeNull();
    expect(stampedDepth({ afterglowDepth: -1 })).toBeNull();
    expect(stampedDepth({ afterglowDepth: 1.5 })).toBeNull();
    expect(stampedDepth({ afterglowDepth: 0 })).toBe(0);
    expect(stampedDepth({ afterglowDepth: 4 })).toBe(4);
  });

  it("leaves the router's own history state untouched", () => {
    const routerState = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", {}] };
    const stamped = withDepth(routerState, 2);
    expect(stamped.__NA).toBe(true);
    expect(stamped.__PRIVATE_NEXTJS_INTERNALS_TREE).toBe(routerState.__PRIVATE_NEXTJS_INTERNALS_TREE);
    expect(stampedDepth(stamped)).toBe(2);
  });

  it("ignores a stored depth that is not a depth", () => {
    const store = new Map<string, string>([[navigationDepthKey, "not a number"]]);
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: () => {}, removeItem: () => {} };
    expect(readLastDepth(storage)).toBeNull();
    expect(currentDepth(null, storage)).toBe(rootDepth);
  });

  it("spends a claimed depth once and never applies it to a later navigation", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    claimDepth(storage, rootDepth);
    expect(takeClaimedDepth(storage)).toBe(rootDepth);
    expect(takeClaimedDepth(storage)).toBeNull();
  });

  it("names a management fallback for the surfaces that reach editing", () => {
    expect(backFallbacks.creations).toBe("/?view=creations");
  });

  it("keeps every fallback inside the app", () => {
    for (const fallback of Object.values(backFallbacks)) {
      expect(fallback.startsWith("/")).toBe(true);
      expect(fallback.startsWith("//")).toBe(false);
    }
  });
});
