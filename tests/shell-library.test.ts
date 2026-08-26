import { describe, expect, it } from "vitest";
import { mergeCreationLists } from "@/lib/shell-library";
import type { Character } from "@/lib/types";

/**
 * The blank Chats page, reproduced and then prevented.
 *
 * Chats renders its rows from this list. Before this sprint the list was built
 * with `Promise.all`, so ONE failed request emptied it, nothing retried, and
 * the only error surface was inside the chat panel — invisible on Chats. The
 * page showed its footer and no stories until the tab was reloaded, which is
 * exactly what was reported. Each case below is one of the ways that happened.
 */

const creation = (id: string, name = id): Character => ({ id, name } as unknown as Character);
const failure = { ok: false as const, reason: new Error("Sign in to continue") };
const ok = (characters: Character[]) => ({ ok: true as const, value: characters });

describe("both requests succeed", () => {
  it("prefers the live owned card over a frozen chat snapshot", () => {
    const live = { ...creation("a"), worldIds: ["w1"] } as Character;
    const snapshot = { ...creation("a"), worldIds: [] } as Character;
    const result = mergeCreationLists(ok([live]), ok([snapshot]));
    expect(result.characters).toHaveLength(1);
    expect(result.characters[0].worldIds).toEqual(["w1"]);
    expect(result.partial).toBe(false);
  });

  it("keeps creations that have no story yet", () => {
    const result = mergeCreationLists(ok([creation("a"), creation("b")]), ok([creation("b")]));
    expect(result.characters.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("one request fails", () => {
  it("still shows the half that arrived — the page is no longer empty", () => {
    const result = mergeCreationLists(failure, ok([creation("a"), creation("b")]));
    expect(result.failed).toBe(false);
    expect(result.characters.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.partial).toBe(true);
  });

  it("does not delete creations already on screen that the half answer omits", () => {
    // The owner's own creations are missing from a chats-only answer. Dropping
    // them would empty the sidebar and Your Creations for no reason.
    const onScreen = [creation("a"), creation("mine")];
    const result = mergeCreationLists(failure, ok([creation("a")]), onScreen);
    expect(result.characters.map((item) => item.id)).toEqual(["a", "mine"]);
  });

  it("never duplicates a creation present on both sides", () => {
    const result = mergeCreationLists(ok([creation("a")]), failure, [creation("a"), creation("b")]);
    expect(result.characters.map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("both requests fail", () => {
  it("reports failure and holds what was already shown, rather than blanking", () => {
    const onScreen = [creation("a")];
    const result = mergeCreationLists(failure, failure, onScreen);
    expect(result.failed).toBe(true);
    // The caller retries once and then shows the banner. Either way the reader
    // does not silently lose the list they were looking at a second ago.
    expect(result.characters).toEqual(onScreen);
  });

  it("is empty only when there was genuinely nothing to keep", () => {
    expect(mergeCreationLists(failure, failure, []).characters).toEqual([]);
  });
});
