import { normalizeBlocks } from "@/lib/rich-content";
import { adultTagsIn } from "@/lib/tags";
import type { Character, CharacterCastMember, CharacterGalleryImage, CreationType } from "@/lib/types";

/**
 * The studio's working copy of a creation.
 *
 * It is the character payload the API already accepts, minus the fields the
 * server owns (identity, timestamps, public counters), plus the staged gallery
 * — which is saved through its own endpoint once the creation has an id.
 */
export type CreationDraft = Omit<
  Character,
  "id" | "createdAt" | "updatedAt" | "ownedByViewer" | "saveCount" | "savedByViewer" | "creator" | "gallery" | "publicStats"
> & {
  gallery: StagedGalleryImage[];
  /**
   * World material an import separated out, waiting to be confirmed.
   *
   * The lore itself lives in `lorebook`, which the studio already promotes to
   * a reusable World on save; this only carries the name and description the
   * importer proposed for it, so a separated world is called something better
   * than "Imported world". Nothing persistent is created until the creator
   * saves, and they can edit or clear it first — an import never leaves an
   * unwanted World behind in their library.
   */
  proposedWorld: { name: string; description: string } | null;
};

export type StagedGalleryImage = Pick<CharacterGalleryImage, "storagePath" | "externalUrl" | "caption">;

export const blankCastMember: CharacterCastMember = { name: "", role: "", description: "", tagline: "", avatarPath: "", avatarUrl: "" };

export const blankDraft: CreationDraft = {
  name: "",
  creationType: "character",
  title: "",
  profileType: "single",
  tagline: "",
  description: "",
  descriptionRich: [],
  userRole: "",
  avatarUrl: "",
  avatarPath: "",
  accent: "#e879a9",
  backstory: "",
  cast: [],
  lorebook: "",
  personality: "",
  scenario: "",
  greeting: "",
  greetingRich: [],
  alternateGreetings: [],
  alternateGreetingsRich: [],
  exampleDialogue: "",
  responseDirective: "",
  boundaries: "",
  sourceMaterial: "",
  worldIds: [],
  tags: [],
  hashtags: [],
  quickFacts: [],
  gallery: [],
  proposedWorld: null,
  visibility: "private",
  // Every creation starts clean and unclassified for sharing. Both are
  // decisions somebody makes, not defaults worth inheriting.
  contentMode: "clean",
  nsfwEnabled: false,
  shareTitle: "",
  shareTagline: "",
  shareImagePath: "",
  shareImageUrl: "",
  // No banner and no framing: an untouched creation renders exactly as every
  // creation did before framing existed.
  bannerPath: "",
  bannerUrl: "",
  artPresentation: {},
  shareMediaStatus: "unreviewed",
};

/**
 * A deep-enough copy that editing the draft never mutates the loaded record.
 *
 * The input is deliberately loose: a `Character` from the API, a stored draft
 * read back out of local storage, or an AI result. Anything absent falls back
 * to the blank draft, so a draft written before a field existed loads rather
 * than being discarded.
 */
export function draftFromCharacter(character?: (Partial<Character> & Partial<Pick<CreationDraft, "proposedWorld">> & { name?: string }) | null): CreationDraft {
  if (!character) return { ...blankDraft, cast: [], alternateGreetings: [], alternateGreetingsRich: [], descriptionRich: [], greetingRich: [], worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [] };
  const creationType: CreationType = character.creationType
    ?? (character.profileType === "ensemble" ? "cast" : "character");
  return {
    ...blankDraft,
    ...character,
    creationType,
    profileType: creationType === "character" ? "single" : "ensemble",
    cast: (character.cast ?? []).map((member) => ({ ...blankCastMember, ...member })),
    alternateGreetings: [...(character.alternateGreetings ?? [])],
    descriptionRich: normalizeBlocks(character.descriptionRich),
    greetingRich: normalizeBlocks(character.greetingRich),
    alternateGreetingsRich: (character.alternateGreetingsRich ?? []).map((blocks) => normalizeBlocks(blocks)),
    worldIds: [...(character.worldIds ?? [])],
    tags: [...(character.tags ?? [])],
    hashtags: [...(character.hashtags ?? [])],
    quickFacts: (character.quickFacts ?? []).map((fact) => ({ ...fact })),
    gallery: (character.gallery ?? []).map((image) => ({ storagePath: image.storagePath, externalUrl: image.externalUrl, caption: image.caption })),
    proposedWorld: character.proposedWorld ? { ...character.proposedWorld } : null,
  };
}

/**
 * The body the character API expects.
 *
 * The gallery is stripped because it has its own endpoint, and `name` falls
 * back to the title so a scenario — which legitimately has no character — can
 * still satisfy the column the schema requires.
 */
export function draftPayload(draft: CreationDraft) {
  const title = draft.title.trim();
  const name = draft.name.trim() || title;
  // The gallery has its own endpoint, and the proposed world is studio-local
  // until the creator saves and it becomes a real World.
  const { gallery: _gallery, proposedWorld: _proposedWorld, ...rest } = draft;
  void _gallery;
  void _proposedWorld;
  return {
    ...rest,
    name,
    // A single character whose title was never edited keeps title and name in
    // step, which is what a creator expects from "Seraphine".
    title: title || (draft.creationType === "character" ? name : ""),
    profileType: draft.creationType === "character" ? "single" as const : "ensemble" as const,
  };
}

/**
 * Whether a session holds work worth keeping.
 *
 * This is the one meaningful-content check in the studio. Autosave writes only
 * when it is true, restoration happens only when it is true, and the "your work
 * was restored" notice appears only when it is true — so opening the studio,
 * letting React initialise its state, walking between steps and closing again
 * leaves nothing behind to resurrect.
 *
 * Meaning is measured against a baseline rather than against emptiness, so an
 * existing creation is dirty when it differs from the record on the server, not
 * merely because that record has text in it. After a successful save the
 * baseline is the saved copy, which is what stops a just-published creation
 * from restoring itself as unsaved work the next time it is opened.
 *
 * The creation type is deliberately excluded for a new creation: it is the
 * intro screen's own selector, its default is "character", and choosing a shape
 * before typing anything is not yet a draft. When editing, a type switch is a
 * real change to a real record, so it counts.
 */
const meaningfulText = [
  "name", "title", "tagline", "description", "userRole", "backstory", "lorebook",
  "personality", "scenario", "greeting", "exampleDialogue", "responseDirective",
  "boundaries", "sourceMaterial", "avatarUrl", "avatarPath", "accent",
] as const satisfies readonly (keyof CreationDraft)[];

function contentSignature(draft: CreationDraft, includeType: boolean) {
  return JSON.stringify([
    includeType ? draft.creationType : "",
    ...meaningfulText.map((field) => String(draft[field] ?? "").trim()),
    draft.visibility,
    draft.nsfwEnabled,
    // A cast member added and left blank is still a deliberate act, so the
    // count matters as much as what was typed into it.
    draft.cast.map((member) => [member.name, member.role, member.description, member.tagline, member.avatarPath, member.avatarUrl].map((value) => String(value ?? "").trim())),
    draft.alternateGreetings.map((greeting) => greeting.trim()),
    [...draft.worldIds].sort(),
    [...draft.tags].sort(),
    [...draft.hashtags].sort(),
    draft.quickFacts.map((fact) => [String(fact.label ?? "").trim(), String(fact.value ?? "").trim()]),
    draft.gallery.map((image) => [image.storagePath, image.externalUrl, image.caption]),
    // A separated world is real work an import produced, so a session holding
    // one is not an empty session even before anything else is typed.
    draft.proposedWorld ? [draft.proposedWorld.name.trim(), draft.proposedWorld.description.trim()] : "",
  ]);
}

export function isMeaningfulDraft(draft: CreationDraft, baseline?: CreationDraft | null) {
  const against = baseline ?? blankDraft;
  const includeType = Boolean(baseline);
  return contentSignature(draft, includeType) !== contentSignature(against, includeType);
}

/** Everything the studio needs to decide whether publishing may proceed. */
export type DraftProblem = { step: string; message: string };

export function draftProblems(draft: CreationDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (!draft.title.trim() && !draft.name.trim()) {
    problems.push({ step: "basics", message: "Give the creation a title." });
  }
  if (draft.creationType === "cast" && draft.cast.length === 0) {
    problems.push({ step: "definition", message: "Add at least one character to the cast." });
  }
  /*
   * A member somebody wrote into but never named.
   *
   * An untouched placeholder is dropped on save — it is editing state, not a
   * character. One with a role or a definition in it is real work, so it is
   * named here rather than discarded, and the creator is told which card to
   * open instead of being handed "cast → 1 → name" by the server.
   */
  const unnamed = draft.cast
    .map((member, index) => ({ member, position: index + 1 }))
    .filter(({ member }) => !member.name.trim()
      && [member.role, member.description, member.tagline, member.avatarPath, member.avatarUrl].some((value) => String(value ?? "").trim()));
  for (const { position } of unnamed) {
    problems.push({ step: "definition", message: `Cast member ${position} needs a name.` });
  }
  if (draft.creationType === "scenario" && !draft.scenario.trim() && !draft.backstory.trim()) {
    problems.push({ step: "definition", message: "Describe what happens in this scenario." });
  }
  // Adult tags and the content mode cannot disagree. Choosing an adult tag
  // selects the 18+ mode for the creator; this is the guard for the case where
  // they then change it back, so nothing tagged 18+ is published as an open
  // page. Adult-CAPABLE is not enough here: these are the platform's explicitly
  // 18+ categories, not the "may become explicit" case.
  const adult = adultTagsIn(draft.tags);
  if (adult.length && draft.contentMode !== "adult_focused") {
    problems.push({
      step: "publish",
      message: `${adult.slice(0, 3).join(", ")}${adult.length > 3 ? ` and ${adult.length - 3} more` : ""} ${adult.length === 1 ? "is an adult tag" : "are adult tags"}. Turn on adult mode, or remove ${adult.length === 1 ? "it" : "them"} from your tags.`,
    });
  }
  return problems;
}
