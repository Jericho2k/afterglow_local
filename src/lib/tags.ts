/**
 * Platform tag taxonomy and creator hashtags.
 *
 * These are two deliberately separate systems. Tags are a controlled
 * vocabulary the platform defines, so they can drive filtering, browsing and
 * recommendation. Hashtags are freeform creator vocabulary — fandoms, niche
 * dynamics, private jokes — and are never promoted into the taxonomy.
 *
 * The taxonomy is presentation metadata only: `characters.tags` still accepts
 * any short string, so tags typed before this file existed keep rendering and
 * keep being editable. Removing a tag from the taxonomy never deletes it from
 * a creation that already carries it.
 */

export type PlatformTagCategory = {
  id: string;
  label: string;
  /** Why a creator would reach for this group, shown above its chips. */
  hint: string;
  tags: string[];
};

export const platformTagCategories: PlatformTagCategory[] = [
  {
    id: "identity",
    label: "Identity",
    hint: "Who the creation is centred on.",
    tags: ["Female", "Male", "Non-binary", "Multiple", "Monster", "Robot / AI", "Animal / Beast", "Deity"],
  },
  {
    id: "pov",
    label: "Point of view",
    hint: "Who the reader plays as.",
    tags: ["AnyPOV", "MalePOV", "FemalePOV", "NonBinaryPOV", "GroupPOV", "Narrator"],
  },
  {
    id: "genre",
    label: "Genre",
    hint: "The kind of story this is.",
    tags: ["Romance", "Drama", "Fantasy", "Sci-Fi", "Adventure", "Horror", "Mystery", "Comedy", "Slice of Life", "Historical", "Thriller", "Supernatural", "Post-Apocalyptic", "Cyberpunk"],
  },
  {
    id: "relationship",
    label: "Relationship",
    hint: "The dynamic between the reader and the story.",
    tags: ["Enemies to Lovers", "Friends to Lovers", "Slow Burn", "Forbidden", "Arranged", "Rivals", "Reunion", "Found Family", "Unrequited"],
  },
  {
    id: "dynamic",
    label: "Personality & dynamic",
    hint: "How the characters behave.",
    tags: ["Dominant", "Submissive", "Switch", "Tsundere", "Yandere", "Protective", "Playful", "Cold", "Nurturing", "Mischievous", "Stoic"],
  },
  {
    id: "setting",
    label: "Setting",
    hint: "Where it happens.",
    tags: ["Modern", "School / Academy", "Workplace", "Royal Court", "Space", "Wasteland", "Small Town", "Underworld", "Military", "Academy of Magic", "Open World"],
  },
  {
    id: "themes",
    label: "Themes",
    hint: "Tone and subject matter.",
    tags: ["Angst", "Comfort", "Hurt / Comfort", "Redemption", "Survival", "Power Struggle", "Found Identity", "Revenge", "Mystery Box", "Slice of Peace", "OC", "Fandom"],
  },
  {
    id: "format",
    label: "Format",
    hint: "How the roleplay is structured.",
    tags: ["RPG", "Multiplayer Cast", "Interactive Fiction", "Choose Your Path", "Long Form", "Quick Play"],
  },
];

export const platformTags = platformTagCategories.flatMap((category) => category.tags);

const platformTagLookup = new Map(platformTags.map((tag) => [tag.toLowerCase(), tag]));

/** True when a stored tag belongs to the taxonomy rather than being legacy input. */
export function isPlatformTag(tag: string) {
  return platformTagLookup.has(tag.trim().toLowerCase());
}

/**
 * Snaps a tag onto its canonical taxonomy spelling when one exists, so
 * "romance" typed by hand and "Romance" chosen from the picker are one tag.
 * Anything unknown is returned trimmed and otherwise untouched.
 */
export function canonicalTag(tag: string) {
  const trimmed = tag.trim();
  return platformTagLookup.get(trimmed.toLowerCase()) ?? trimmed;
}

export const maxTags = 20;
export const maxHashtags = 20;

/**
 * Creator input to stored hashtag: no leading "#", lowercase, and only
 * characters that can round-trip through a URL. Returns "" when nothing
 * usable remains, which callers treat as "do not add".
 */
export function normalizeHashtag(value: string) {
  return value
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 40);
}

/** Splits pasted text such as "#mha #villainau, slowburn" into hashtags. */
export function parseHashtags(value: string) {
  return value.split(/[\s,]+/).map(normalizeHashtag).filter(Boolean);
}

export function formatHashtag(value: string) {
  return `#${value}`;
}
