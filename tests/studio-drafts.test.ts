import { describe, expect, it } from "vitest";
import { blankDraft, draftFromCharacter, type CreationDraft } from "@/components/studio/draft";
import {
  draftKeyPrefix, draftLabel, draftStorageKey, forgetAllStoredDrafts, forgetStoredDraft,
  hasResumableDrafts, listStoredDrafts, readStoredDraft, writeStoredDraft,
} from "@/components/studio/drafts";

/**
 * Drafts a creator can actually find.
 *
 * The studio has always mirrored an interrupted session into storage; what it
 * never had was a way to see one. These assert the two halves of that: every
 * real draft is offered back with enough information to recognise it, and the
 * empty-session rule the previous fix established still holds — opening
 * Create, letting the form initialise and leaving must produce no card.
 */

/** A local-storage stand-in, so these run without a browser. */
function store() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    removeItem: (key: string) => { map.delete(key); },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() { return map.size; },
  };
}

const draft = (changes: Partial<CreationDraft>) => ({ ...draftFromCharacter(null), ...changes });

function put(target: ReturnType<typeof store>, key: string, value: CreationDraft, savedAt = "2026-08-01T12:00:00.000Z") {
  target.setItem(key, JSON.stringify({ savedAt, draft: value }));
}

describe("what appears in Continue where you left off", () => {
  it("offers back a new creation that was actually written into", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ title: "Seraphine", tagline: "She writes your name in the margins." }));
    const [summary] = listStoredDrafts(target);
    expect(summary.label).toBe("Seraphine");
    expect(summary.creationId).toBeNull();
    expect(summary.draft.tagline).toBe("She writes your name in the margins.");
  });

  it("shows nothing at all for a session that was opened and abandoned", () => {
    const target = store();
    put(target, draftStorageKey(null), blankDraft);
    expect(listStoredDrafts(target)).toEqual([]);
    expect(hasResumableDrafts(target)).toBe(false);
    // Not merely hidden: the empty record is removed, so it cannot come back.
    expect(target.map.has(draftStorageKey(null))).toBe(false);
  });

  it("does not count choosing a structure on the Create screen as a draft", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ creationType: "scenario", profileType: "ensemble" }));
    expect(listStoredDrafts(target)).toEqual([]);
  });

  it("does not count whitespace typed and deleted again", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ title: "   ", description: "\n\n" }));
    expect(listStoredDrafts(target)).toEqual([]);
  });

  it("counts work that is not typed text, such as tags, a world or a cast member", () => {
    for (const changes of [
      { tags: ["Romance"] },
      { hashtags: ["mha"] },
      { worldIds: ["11111111-1111-4111-8111-111111111111"] },
      { cast: [{ name: "Maya", role: "", description: "", tagline: "", avatarPath: "", avatarUrl: "" }] },
      { gallery: [{ storagePath: "", externalUrl: "https://cdn.example/a.png", caption: "" }] },
      { quickFacts: [{ label: "Age", value: "34" }] },
      { alternateGreetings: ["A different way in."] },
      { nsfwEnabled: true },
      { proposedWorld: { name: "Ardenholt", description: "A kingdom without a king." } },
    ] as Partial<CreationDraft>[]) {
      const target = store();
      put(target, draftStorageKey(null), draft(changes));
      expect(listStoredDrafts(target)).toHaveLength(1);
    }
  });

  it("lists unsaved edits to a saved creation as belonging to it", () => {
    const target = store();
    const id = "aaaaaaaa-0000-4000-8000-000000000001";
    put(target, draftStorageKey(id), draft({ title: "Seraphine", personality: "Guarded, sharp." }));
    const [summary] = listStoredDrafts(target);
    expect(summary.creationId).toBe(id);
    expect(summary.key).toBe(`${draftKeyPrefix}${id}`);
  });

  it("orders the most recently edited draft first", () => {
    const target = store();
    put(target, draftStorageKey("aaaa"), draft({ title: "Older" }), "2026-08-01T09:00:00.000Z");
    put(target, draftStorageKey(null), draft({ title: "Newer" }), "2026-08-02T09:00:00.000Z");
    expect(listStoredDrafts(target).map((item) => item.label)).toEqual(["Newer", "Older"]);
  });

  it("ignores keys that are not studio drafts", () => {
    const target = store();
    target.setItem("afterglow:discovery", JSON.stringify({ creations: [] }));
    target.setItem("unrelated", "value");
    put(target, draftStorageKey(null), draft({ title: "Seraphine" }));
    expect(listStoredDrafts(target)).toHaveLength(1);
  });

  it("discards a stored value that is not a draft at all rather than failing", () => {
    const target = store();
    target.setItem(draftStorageKey(null), "not json");
    target.setItem(draftStorageKey("bbbb"), JSON.stringify({ savedAt: "x" }));
    expect(listStoredDrafts(target)).toEqual([]);
    expect(target.map.size).toBe(0);
  });

  it("reads a draft written by an older build, filling in fields it never had", () => {
    const target = store();
    target.setItem(draftStorageKey(null), JSON.stringify({
      savedAt: "2026-08-01T12:00:00.000Z",
      draft: { name: "Mara", title: "Mara", personality: "Dry." },
    }));
    const [summary] = listStoredDrafts(target);
    expect(summary.label).toBe("Mara");
    expect(summary.draft.tags).toEqual([]);
    expect(summary.draft.proposedWorld).toBeNull();
    expect(summary.draft.visibility).toBe("private");
  });

  it("survives storage being unavailable entirely", () => {
    expect(listStoredDrafts(null)).toEqual([]);
    expect(hasResumableDrafts(null)).toBe(false);
    expect(() => writeStoredDraft("k", blankDraft, null)).not.toThrow();
    expect(() => forgetStoredDraft("k", null)).not.toThrow();
  });
});

describe("how a draft names itself", () => {
  it("uses the creation's title when it has one", () => {
    expect(draftLabel(draft({ title: "The Final War", creationType: "scenario" }))).toBe("The Final War");
  });

  it("falls back to the character's name when only that was typed", () => {
    expect(draftLabel(draft({ name: "Seraphine" }))).toBe("Seraphine");
  });

  it("names an untitled draft after what it is, not after nothing", () => {
    expect(draftLabel(draft({ personality: "Guarded." }))).toBe("Untitled character");
    expect(draftLabel(draft({ creationType: "cast", profileType: "ensemble", scenario: "Three roommates." }))).toBe("Untitled cast");
    expect(draftLabel(draft({ creationType: "scenario", profileType: "ensemble", scenario: "A siege." }))).toBe("Untitled scenario");
  });
});

describe("continuing a draft restores all of it", () => {
  it("round-trips every persisted field through storage", () => {
    const target = store();
    const rich: CreationDraft = draft({
      creationType: "cast",
      profileType: "ensemble",
      title: "Roommates From Hell",
      name: "Roommates From Hell",
      tagline: "Three roommates. One apartment.",
      description: "The lease is up in eleven months.",
      userRole: "The fourth roommate.",
      scenario: "Nobody can afford to break it.",
      backstory: "They met through an advert.",
      personality: "Rivalries and running jokes.",
      responseDirective: "Move between them; never write for the reader.",
      boundaries: "Consent always.",
      exampleDialogue: "Maya: …",
      greeting: "The kitchen light is still on.",
      alternateGreetings: ["It is nine in the morning and nobody has slept."],
      sourceMaterial: "the original paste",
      lorebook: "The building has one working lift.",
      proposedWorld: { name: "Meridian Street", description: "One street, one building." },
      cast: [
        { name: "Maya", role: "Nurse", description: "Dry, tired.", tagline: "Pays the bills.", avatarPath: "", avatarUrl: "" },
        { name: "Sophie", role: "Art student", description: "Chaos.", tagline: "Talks to the toaster.", avatarPath: "", avatarUrl: "" },
      ],
      tags: ["Comedy", "Slice of Life"],
      hashtags: ["chaos", "roommates"],
      quickFacts: [{ label: "Cast", value: "Three" }],
      gallery: [{ storagePath: "", externalUrl: "https://cdn.example/kitchen.png", caption: "The kitchen" }],
      worldIds: ["11111111-1111-4111-8111-111111111111"],
      avatarUrl: "https://cdn.example/cover.png",
      accent: "#b892f0",
      visibility: "unlisted",
      nsfwEnabled: true,
    });

    writeStoredDraft(draftStorageKey(null), rich, target);
    const [summary] = listStoredDrafts(target);
    // Nothing is summarised on the way in or out: the stored object is the
    // whole draft, so Continue restores the session rather than an outline.
    expect(summary.draft).toEqual(rich);
    expect(readStoredDraft(null, target)?.draft).toEqual(rich);
  });

  it("stamps every write with when it happened, so the card can say", () => {
    const target = store();
    writeStoredDraft(draftStorageKey(null), draft({ title: "Seraphine" }), target);
    const [summary] = listStoredDrafts(target);
    expect(Number.isFinite(Date.parse(summary.savedAt))).toBe(true);
  });
});

describe("discarding", () => {
  it("stays discarded rather than reappearing", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ title: "Seraphine" }));
    forgetStoredDraft(draftStorageKey(null), target);
    expect(listStoredDrafts(target)).toEqual([]);
    expect(readStoredDraft(null, target)).toBeNull();
  });

  it("removes only the draft it was asked to remove", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ title: "New work" }));
    put(target, draftStorageKey("aaaa"), draft({ title: "Saved creation" }));
    forgetStoredDraft(draftStorageKey(null), target);
    expect(listStoredDrafts(target).map((item) => item.label)).toEqual(["Saved creation"]);
  });
});

/**
 * Drafts belong to the device, not to the account.
 *
 * They have no server side, which is fine while nothing lists them and not
 * fine now that the Create screen offers them back by name: on a shared
 * computer that would hand one person's unfinished work to whoever signs in
 * next. Signing out is the moment the previous account stops being the one
 * using this browser.
 */
describe("signing out", () => {
  it("leaves no draft behind for the next account", () => {
    const target = store();
    put(target, draftStorageKey(null), draft({ title: "Private work in progress" }));
    put(target, draftStorageKey("aaaa"), draft({ title: "Unsaved edits" }));
    target.setItem("afterglow:discovery", "{}");
    forgetAllStoredDrafts(target);
    expect(listStoredDrafts(target)).toEqual([]);
    // Only drafts. Nothing else in storage is the account's private work.
    expect(target.map.has("afterglow:discovery")).toBe(true);
  });

  it("is safe when storage is unavailable", () => {
    expect(() => forgetAllStoredDrafts(null)).not.toThrow();
  });
});
