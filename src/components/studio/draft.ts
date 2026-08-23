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
  "id" | "createdAt" | "updatedAt" | "ownedByViewer" | "likeCount" | "likedByViewer" | "creator" | "gallery" | "publicStats"
> & { gallery: StagedGalleryImage[] };

export type StagedGalleryImage = Pick<CharacterGalleryImage, "storagePath" | "externalUrl" | "caption">;

export const blankCastMember: CharacterCastMember = { name: "", role: "", description: "", tagline: "", avatarPath: "", avatarUrl: "" };

export const blankDraft: CreationDraft = {
  name: "",
  creationType: "character",
  title: "",
  profileType: "single",
  tagline: "",
  description: "",
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
  alternateGreetings: [],
  exampleDialogue: "",
  responseDirective: "",
  boundaries: "",
  sourceMaterial: "",
  worldIds: [],
  tags: [],
  hashtags: [],
  quickFacts: [],
  gallery: [],
  visibility: "private",
  nsfwEnabled: false,
};

/** A deep-enough copy that editing the draft never mutates the loaded record. */
export function draftFromCharacter(character?: (Partial<Character> & { name?: string }) | null): CreationDraft {
  if (!character) return { ...blankDraft, cast: [], alternateGreetings: [], worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [] };
  const creationType: CreationType = character.creationType
    ?? (character.profileType === "ensemble" ? "cast" : "character");
  return {
    ...blankDraft,
    ...character,
    creationType,
    profileType: creationType === "character" ? "single" : "ensemble",
    cast: (character.cast ?? []).map((member) => ({ ...blankCastMember, ...member })),
    alternateGreetings: [...(character.alternateGreetings ?? [])],
    worldIds: [...(character.worldIds ?? [])],
    tags: [...(character.tags ?? [])],
    hashtags: [...(character.hashtags ?? [])],
    quickFacts: (character.quickFacts ?? []).map((fact) => ({ ...fact })),
    gallery: (character.gallery ?? []).map((image) => ({ storagePath: image.storagePath, externalUrl: image.externalUrl, caption: image.caption })),
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
  const { gallery: _gallery, ...rest } = draft;
  void _gallery;
  return {
    ...rest,
    name,
    // A single character whose title was never edited keeps title and name in
    // step, which is what a creator expects from "Seraphine".
    title: title || (draft.creationType === "character" ? name : ""),
    profileType: draft.creationType === "character" ? "single" as const : "ensemble" as const,
  };
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
  if (draft.creationType === "scenario" && !draft.scenario.trim() && !draft.backstory.trim()) {
    problems.push({ step: "definition", message: "Describe what happens in this scenario." });
  }
  return problems;
}
