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
