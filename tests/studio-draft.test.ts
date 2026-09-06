import { describe, expect, it } from "vitest";
import {
  blankCastMember, blankDraft, draftFromCharacter, isMeaningfulDraft,
  type CreationDraft,
} from "@/components/studio/draft";

/**
 * When a creation session becomes a draft.
 *
 * The rule the studio is built on: no meaningful user input, no draft. Opening
 * the studio, letting it initialise, walking between steps and closing again
 * must leave nothing behind — no stored object, no restore notice, and no
 * reason to skip the intro screen next time. Anything the creator actually did
 * must survive, because that is the feature this correctness fix exists to
 * protect rather than to remove.
 *
 * `isMeaningfulDraft` is the single check the studio consults for all three
 * decisions (write, restore, notify), so these are the semantics of all three.
 */

const fresh = () => draftFromCharacter(null);
const edited = (changes: Partial<CreationDraft>) => ({ ...fresh(), ...changes });

describe("an untouched session is not a draft", () => {
  it("treats the state the studio initialises with as nothing at all", () => {
    expect(isMeaningfulDraft(fresh())).toBe(false);
    expect(isMeaningfulDraft(blankDraft)).toBe(false);
  });

  it("is unmoved by whitespace typed and deleted again", () => {
    expect(isMeaningfulDraft(edited({ title: "   ", description: "\n\n" }))).toBe(false);
  });

  it("does not count choosing what to make on the intro screen", () => {
    // The intro screen owns this selector. Choosing a shape and leaving must
    // bring the intro screen back rather than dropping straight into Basics.
    expect(isMeaningfulDraft(edited({ creationType: "scenario", profileType: "ensemble" }))).toBe(false);
    expect(isMeaningfulDraft(edited({ creationType: "cast", profileType: "ensemble" }))).toBe(false);
  });

  it("does not count empty lists, which is all a defaulted draft holds", () => {
    expect(isMeaningfulDraft(edited({ tags: [], hashtags: [], cast: [], worldIds: [], gallery: [], quickFacts: [], alternateGreetings: [] }))).toBe(false);
  });
});

describe("a real edit is a draft", () => {
  const cases: [string, Partial<CreationDraft>][] = [
    ["a title", { title: "Seraphine" }],
    ["a name", { name: "Seraphine" }],
    ["a tagline", { tagline: "She writes your name in the margins." }],
    ["a description", { description: "A poet who keeps her drafts hidden." }],
    ["a personality", { personality: "Guarded, sharp." }],
    ["a scenario", { scenario: "The siege has lasted a year." }],
    ["a backstory", { backstory: "She left the city at seventeen." }],
    ["an opening", { greeting: "You find her notebook." }],
    ["an alternate opening", { alternateGreetings: ["She is already waiting."] }],
    ["example dialogue", { exampleDialogue: "\"You again.\"" }],
    ["a response directive", { responseDirective: "Always second person." }],
    ["boundaries", { boundaries: "No violence." }],
    ["pasted source material", { sourceMaterial: "a pasted card" }],
    ["a tag", { tags: ["Romance"] }],
    ["a hashtag", { hashtags: ["darkacademia"] }],
    ["an uploaded cover", { avatarPath: "covers/abc.png" }],
    ["a linked cover", { avatarUrl: "https://cdn.example/abc.png" }],
    ["a gallery image", { gallery: [{ storagePath: "g/1.png", externalUrl: "", caption: "" }] }],
    ["a cast member", { cast: [{ ...blankCastMember, name: "Mira" }] }],
    ["a blank cast member somebody deliberately added", { cast: [{ ...blankCastMember }] }],
    ["an attached world", { worldIds: ["bbbbbbbb-0000-4000-8000-000000000001"] }],
    ["a quick fact", { quickFacts: [{ label: "Age", value: "27" }] }],
    ["a visibility change", { visibility: "public" }],
    ["adult mode", { nsfwEnabled: true }],
    ["an accent colour", { accent: "#7bd4ff" }],
  ];

  for (const [what, changes] of cases) {
    it(`counts ${what}`, () => {
      expect(isMeaningfulDraft(edited(changes))).toBe(true);
    });
  }

  it("counts a tag on its own, with nothing else touched", () => {
    // The case the sprint calls out by name: tags alone are restorable work.
    expect(isMeaningfulDraft(edited({ tags: ["BDSM"] }))).toBe(true);
  });

  it("stops counting once the creator deletes what they typed", () => {
    const typed = edited({ title: "Seraphine" });
    expect(isMeaningfulDraft(typed)).toBe(true);
    expect(isMeaningfulDraft({ ...typed, title: "" })).toBe(false);
  });
});

describe("editing an existing creation", () => {
  const record = draftFromCharacter({
    name: "Seraphine",
    title: "Seraphine",
    creationType: "character",
    tagline: "The girl who writes your name in the margins.",
    tags: ["Romance", "Drama"],
    hashtags: ["darkacademia"],
    visibility: "public",
  });

  it("does not call the loaded record unsaved work merely because it has content", () => {
    // A published creation reopened for editing is not a restored draft.
    expect(isMeaningfulDraft({ ...record }, record)).toBe(false);
  });

  it("notices a change made against that record", () => {
    expect(isMeaningfulDraft({ ...record, tagline: "Rewritten." }, record)).toBe(true);
    expect(isMeaningfulDraft({ ...record, tags: [...record.tags, "Slow Burn"] }, record)).toBe(true);
  });

  it("ignores the order tags and worlds happen to be stored in", () => {
    expect(isMeaningfulDraft({ ...record, tags: ["Drama", "Romance"] }, record)).toBe(false);
  });

  it("counts a structure change against a real record, where it is a real change", () => {
    expect(isMeaningfulDraft({ ...record, creationType: "cast" }, record)).toBe(true);
  });

  it("treats the just-saved copy as the new unchanged state", () => {
    // What stops a creation that was successfully published from restoring
    // itself as unsaved work the next time it is opened.
    const saved = { ...record, tagline: "Rewritten." };
    expect(isMeaningfulDraft(saved, record)).toBe(true);
    expect(isMeaningfulDraft(saved, saved)).toBe(false);
  });

  it("treats a discard back to the baseline as nothing to keep", () => {
    const discarded = { ...record };
    expect(isMeaningfulDraft(discarded, record)).toBe(false);
  });
});

describe("a stored draft survives the round trip through storage", () => {
  it("still reads as meaningful after JSON and back", () => {
    const typed = edited({ title: "Seraphine", tags: ["Romance"] });
    const restored = draftFromCharacter(JSON.parse(JSON.stringify(typed)));
    expect(isMeaningfulDraft(restored)).toBe(true);
  });

  it("still reads as empty after JSON and back, so it is deleted rather than restored", () => {
    const untouched = JSON.parse(JSON.stringify(fresh()));
    expect(isMeaningfulDraft(draftFromCharacter(untouched))).toBe(false);
  });

  it("reads a draft written by an older build with missing fields as empty", () => {
    // Older stored objects predate several fields; absent must not read as
    // changed, or every one of them would restore itself forever.
    const legacy = { name: "", title: "", creationType: "character" as const };
    expect(isMeaningfulDraft(draftFromCharacter(legacy))).toBe(false);
  });
});

/**
 * The audit that stops this happening again.
 *
 * Every field added to `CreationDraft` since the signature was written — the
 * outward-facing copy, the nominated share image, the banner, the framing
 * document, the content mode — was added to the draft, to the payload and to
 * the schema, and to none of the studio's dirty checks. The result is a field
 * a creator can edit, that the server stores, and that autosave will not keep:
 * the change survives only if the tab does.
 *
 * So the check is exhaustive rather than a list of examples. Adding a field to
 * the draft and not deciding what it means for dirtiness fails here, by name,
 * with the reason spelled out below.
 */
describe("every creator-editable field is in the draft signature", () => {
  /*
   * A different value for each field, and the reason a handful are exempt.
   *
   * `null` means "deliberately not part of the signature", and each one is a
   * field the CREATOR does not author:
   *
   *   profileType       derived from creationType; changing it alone is not a
   *                     thing the studio can do.
   *   creationType      the intro screen's own selector for a NEW creation —
   *                     covered above, and dirty when editing a record.
   *   shareMediaStatus  the platform's classification of nominated media. A
   *                     moderator approving an image must not make an open
   *                     studio look like it holds unsaved work.
   */
  const changes: Record<keyof CreationDraft, Partial<CreationDraft> | null> = {
    name: { name: "Seraphine" },
    title: { title: "Seraphine" },
    tagline: { tagline: "The girl who writes your name" },
    description: { description: "Sharp-tongued and guarded." },
    descriptionRich: { descriptionRich: [{ type: "image", path: "users/a/inline.png", url: "", caption: "" }] },
    userRole: { userRole: "Her rival" },
    backstory: { backstory: "Raised on the quay." },
    personality: { personality: "Guarded." },
    scenario: { scenario: "A harbour at dusk." },
    greeting: { greeting: "You again." },
    greetingRich: { greetingRich: [{ type: "image", path: "users/a/opening.png", url: "", caption: "" }] },
    alternateGreetings: { alternateGreetings: ["A second way in."] },
    alternateGreetingsRich: { alternateGreetings: ["A second way in."], alternateGreetingsRich: [[{ type: "image", path: "users/a/alt.png", url: "", caption: "" }]] },
    exampleDialogue: { exampleDialogue: "«You: hello»" },
    responseDirective: { responseDirective: "Answer in short lines." },
    boundaries: { boundaries: "No violence." },
    sourceMaterial: { sourceMaterial: "The original paste." },
    lorebook: { lorebook: "The quay was built twice." },
    avatarPath: { avatarPath: "users/a/cover.png" },
    avatarUrl: { avatarUrl: "https://example.test/cover.png" },
    accent: { accent: "#66ccff" },
    cast: { cast: [{ ...blankCastMember, name: "Mara" }] },
    worldIds: { worldIds: ["bbbbbbbb-0000-4000-8000-000000000001"] },
    tags: { tags: ["Romance"] },
    hashtags: { hashtags: ["slowburn"] },
    quickFacts: { quickFacts: [{ label: "Age", value: "27" }] },
    gallery: { gallery: [{ storagePath: "users/a/one.png", externalUrl: "", caption: "" }] },
    proposedWorld: { proposedWorld: { name: "The quay", description: "Separated by the import." } },
    visibility: { visibility: "public" },
    contentMode: { contentMode: "adult_capable" },
    nsfwEnabled: { nsfwEnabled: true },
    shareTitle: { shareTitle: "Slow burn" },
    shareTagline: { shareTagline: "A quiet, unhurried romance." },
    shareImagePath: { shareImagePath: "users/a/share.png" },
    shareImageUrl: { shareImageUrl: "https://example.test/share.png" },
    bannerPath: { bannerPath: "users/a/banner.png" },
    bannerUrl: { bannerUrl: "https://example.test/banner.png" },
    artPresentation: { artPresentation: { cover: { focal: { x: 0.3, y: 0.2 } } } },
    profileType: null,
    creationType: null,
    shareMediaStatus: null,
    // Moderation state. Optional on the record, never on the draft's blank,
    // and written by Afterglow alone — a creation locked while it is reviewed
    // is not a creator's unsaved edit.
    moderationStatus: null,
    moderationReason: null,
  };

  it("accounts for every field the draft carries", () => {
    // Adding a field to `blankDraft` and not deciding here is the failure this
    // exists to produce, and it names the field.
    expect(Object.keys(blankDraft).filter((field) => !(field in changes))).toEqual([]);
  });

  it("counts a change to each of them as unsaved work", () => {
    // A baseline that shares no value with the changes below, so "dirty"
    // means the signature noticed rather than the value happening to differ.
    const record = draftFromCharacter({ name: "Vale", title: "Vale", creationType: "character" });
    const missed = Object.entries(changes)
      .filter(([, change]) => change)
      .filter(([, change]) => !isMeaningfulDraft({ ...record, ...change as Partial<CreationDraft> }, record))
      .map(([field]) => field);
    expect(missed).toEqual([]);
  });

  it("leaves the platform's own classification out of it", () => {
    const record = draftFromCharacter({ name: "Seraphine", title: "Seraphine", creationType: "character" });
    expect(isMeaningfulDraft({ ...record, shareMediaStatus: "safe" }, record)).toBe(false);
  });
});
