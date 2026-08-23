import type { Character, CharacterCastMember, CreationType } from "./types";

/**
 * Creation view model.
 *
 * Everything published is a Creation. The storage layer still calls the row a
 * character, and existing routes, tables and chats keep those names, but no
 * presentation surface may assume that a creation has one primary character or
 * that `character.name` is what to title it with. Every such decision lives
 * here so the studio preview, the feed card and the public page can never
 * disagree.
 */

type CreationLike = Pick<Character, "name" | "title" | "creationType" | "profileType">;

/** The authoring structure, inferred for rows written before creations existed. */
export function creationType(creation: Pick<Character, "creationType" | "profileType">): CreationType {
  if (creation.creationType === "cast" || creation.creationType === "scenario" || creation.creationType === "character") {
    return creation.creationType;
  }
  return creation.profileType === "ensemble" ? "cast" : "character";
}

/**
 * What a card, hero or chat header should be titled with.
 *
 * A creation authored before titles existed has none, and its character name
 * stands in — which is exactly what those pages already displayed, so nothing
 * changes for them.
 */
export function creationTitle(creation: CreationLike) {
  return creation.title.trim() || creation.name.trim() || "Untitled creation";
}

/**
 * The primary character's name, or "" when the creation genuinely has none.
 *
 * A scenario is allowed to have no primary character, and callers must handle
 * that rather than inventing one.
 */
export function primaryCharacterName(creation: Pick<Character, "name" | "title" | "creationType" | "profileType" | "cast">) {
  const type = creationType(creation);
  const name = creation.name.trim();
  if (type === "character") return name;
  // For a cast or scenario the name column often holds the card title itself,
  // which is not a person. Only treat it as a character when it is not simply
  // repeating the title.
  if (name && name !== creation.title.trim()) return name;
  return "";
}

export const creationTypeLabels: Record<CreationType, string> = {
  character: "Character",
  cast: "Cast",
  scenario: "Scenario / RPG",
};

export const creationTypeSummaries: Record<CreationType, string> = {
  character: "One primary character with their own personality, story and goals.",
  cast: "Several defined characters sharing one premise.",
  scenario: "A situation, story or world. The AI narrates and plays the NPCs.",
};

/** Short line under a title on cards and previews. */
export function creationKindLine(creation: Pick<Character, "name" | "title" | "creationType" | "profileType" | "cast">) {
  const type = creationType(creation);
  if (type === "cast") return creation.cast.length ? `Cast · ${creation.cast.length} characters` : "Cast";
  if (type === "scenario") return "Scenario";
  const primary = primaryCharacterName(creation);
  return primary && primary !== creationTitle(creation) ? primary : "Character";
}

/**
 * The public overview.
 *
 * The authored public description wins. Creations written before that field
 * existed fall back to what the page already showed, so no published page
 * suddenly loses its text. Hidden instruction fields — response directive,
 * boundaries, example dialogue — never appear here.
 */
export function creationOverview(creation: Pick<Character, "description" | "backstory" | "personality" | "scenario" | "creationType" | "profileType">) {
  const authored = creation.description.trim();
  if (authored) return authored;
  if (creationType(creation) === "scenario") {
    return [creation.scenario, creation.backstory].map((part) => part.trim()).filter(Boolean).join("\n\n");
  }
  return [creation.backstory, creation.personality].map((part) => part.trim()).filter(Boolean).join("\n\n");
}

/**
 * Cast members that may be shown publicly.
 *
 * A member's `description` is its AI definition and stays private; the public
 * card shows the name, role and the short blurb the creator wrote for it.
 */
export function publicCastMembers(cast: CharacterCastMember[]) {
  return cast.filter((member) => member.name.trim());
}

/** Heading for the cast section, which a scenario labels differently. */
export function castSectionLabel(type: CreationType) {
  return type === "scenario" ? "Important characters" : "Cast";
}

/**
 * The label on the button that enters the story.
 *
 * "Chat with Seraphine" reads right for a character and badly for
 * "Medieval Fantasy World RP", so the wording follows the structure.
 */
export function creationCtaLabel(creation: Pick<Character, "name" | "title" | "creationType" | "profileType" | "cast">) {
  const type = creationType(creation);
  const title = creationTitle(creation);
  if (type === "character") {
    const primary = primaryCharacterName(creation) || title;
    return `Chat with ${primary}`;
  }
  return `Enter ${title}`;
}

/** The same decision, shortened for compact surfaces such as a feed card. */
export function creationShortCta(creation: Pick<Character, "name" | "title" | "creationType" | "profileType" | "cast">) {
  return creationType(creation) === "character" ? "Chat" : "Enter";
}

/** Who the creation is addressed to in a comment placeholder and similar copy. */
export function creationSubject(creation: Pick<Character, "name" | "title" | "creationType" | "profileType" | "cast">) {
  return creationType(creation) === "character" ? primaryCharacterName(creation) || creationTitle(creation) : creationTitle(creation);
}
