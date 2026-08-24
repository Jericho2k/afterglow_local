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
  /**
   * True when every tag in the group describes adult material. Adult tags are
   * ordinary platform tags — they are chosen, filtered and stored exactly like
   * the rest — but they are marked so the pickers can label them 18+ and so
   * the studio can refuse to publish adult-tagged work as safe content.
   */
  adult?: boolean;
  tags: string[];
};

export const platformTagCategories: PlatformTagCategory[] = [
  {
    id: "identity",
    label: "Identity",
    hint: "Who the creation is centred on.",
    // Gender, sex characteristics and species sit together because they answer
    // one browsing question: what kind of being is this? "Anthro / Hybrid"
    // covers beastkin, kemonomimi and human-animal hybrids in one filter —
    // the individual fandom words for them belong in hashtags.
    tags: [
      "Female", "Male", "Non-binary", "Intersex", "Multiple",
      "Monster", "Demon", "Elf", "Vampire", "Werewolf",
      "Robot / AI", "Animal / Beast", "Anthro / Hybrid", "Deity",
    ],
  },
  {
    id: "orientation",
    label: "Orientation",
    hint: "The attraction the story is written around.",
    tags: ["Straight", "Gay", "Lesbian", "Bisexual", "Pansexual", "Asexual", "Demisexual", "Queer"],
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
    tags: ["Romance", "Drama", "Fantasy", "Sci-Fi", "Adventure", "Horror", "Mystery", "Comedy", "Slice of Life", "Historical", "Thriller", "Supernatural", "Post-Apocalyptic", "Cyberpunk", "Isekai"],
  },
  {
    id: "relationship",
    label: "Relationship",
    hint: "The dynamic between the reader and the story.",
    tags: ["Enemies to Lovers", "Friends to Lovers", "Slow Burn", "Forbidden", "Arranged", "Rivals", "Reunion", "Found Family", "Unrequited", "Spouse / Partner", "Step-family"],
  },
  {
    id: "dynamic",
    label: "Personality & dynamic",
    hint: "How the characters behave.",
    // Dominant, Submissive and Switch live here and only here. They describe a
    // dynamic that is just as real in a slow-burn romance as in a kink scene,
    // so the adult groups below deliberately do not restate them.
    tags: ["Dominant", "Submissive", "Switch", "Tsundere", "Yandere", "Protective", "Playful", "Cold", "Nurturing", "Mischievous", "Stoic"],
  },
  {
    id: "setting",
    label: "Setting & role",
    hint: "Where it happens, and the part the cast plays in it.",
    tags: ["Modern", "School / Academy", "Workplace", "Royal Court", "Space", "Wasteland", "Small Town", "Underworld", "Military", "Academy of Magic", "Open World", "Mafia / Gang", "Doctor / Medical", "Maid", "Hero", "Villain"],
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
  {
    id: "adult_kink",
    label: "Adult · kink",
    hint: "Explicit material and the dynamics it is built on. Marked 18+.",
    adult: true,
    // Curated rather than exhaustive: each of these is something a reader
    // would deliberately browse for or deliberately avoid. Anything narrower
    // — a specific implement, a specific position, a specific fandom's
    // vocabulary — is a creator hashtag, not a platform tag.
    tags: [
      "Explicit", "Lewd", "Erotic", "Kinky", "Vanilla", "Seductive",
      "BDSM", "Femdom", "Degradation", "Sadistic", "Brat",
      "Breeding", "Pregnancy", "Omegaverse", "Feet / Foot Fetish", "Size Kink", "Group Sex",
      "Cheating", "Cuckold", "Stag", "Bull / Third", "Vixen",
      // Named as a fiction label on purpose. It marks consensual roleplay of a
      // non-consent fantasy between fictional adults, and the label has to say
      // so wherever it is shown.
      "CNC / Non-consent Fantasy",
    ],
  },
  {
    id: "adult_body",
    label: "Adult · body & archetype",
    hint: "Physical description people filter on in adult work. Marked 18+.",
    adult: true,
    tags: ["Femboy", "Futanari", "MILF", "DILF", "Petite", "Large Breasts", "Small Breasts", "Large Penis", "Small Penis"],
  },
];

export const platformTags = platformTagCategories.flatMap((category) => category.tags);

/**
 * Every tag the taxonomy marks as adult, lowercased for lookup.
 *
 * Adult-marked tags are a property of the taxonomy rather than of a creation:
 * carrying one says the work is adult, which is why the studio will not let it
 * publish with adult mode off and why discovery keeps it out of a feed that
 * has not opted in.
 */
const adultTagLookup = new Set(
  platformTagCategories.filter((category) => category.adult).flatMap((category) => category.tags).map((tag) => tag.toLowerCase()),
);

export const adultTags = platformTagCategories.filter((category) => category.adult).flatMap((category) => category.tags);

export function isAdultTag(tag: string) {
  return adultTagLookup.has(tag.trim().toLowerCase());
}

/** The adult tags in a selection, canonically spelled. Empty for safe work. */
export function adultTagsIn(tags: readonly string[]) {
  return tags.filter(isAdultTag).map(canonicalTag);
}

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
