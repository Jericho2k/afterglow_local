import { describe, expect, it } from "vitest";
import {
  adultTags, adultTagsIn, canonicalTag, isAdultTag, isPlatformTag,
  normalizeHashtag, parseHashtags, platformTagCategories, platformTags,
} from "@/lib/tags";
import { platformTagCategories as studioCategories } from "@/lib/tags";
import { draftProblems, blankDraft } from "@/components/studio/draft";
import { characterSchema } from "@/lib/schemas";

/**
 * The controlled tag taxonomy.
 *
 * Tags are the platform's vocabulary and hashtags are the creator's; the whole
 * point of the split is that neither grows into the other. These assert the
 * properties creations already on the platform depend on — every tag that
 * existed still exists, spelled the same way — alongside the ones the adult
 * categories introduce: adult work is identifiable as adult, and a creator
 * cannot publish it as safe.
 */

/** Everything the taxonomy carried before the adult and orientation groups. */
const preexisting = {
  identity: ["Female", "Male", "Non-binary", "Multiple", "Monster", "Robot / AI", "Animal / Beast", "Deity"],
  pov: ["AnyPOV", "MalePOV", "FemalePOV", "NonBinaryPOV", "GroupPOV", "Narrator"],
  genre: ["Romance", "Drama", "Fantasy", "Sci-Fi", "Adventure", "Horror", "Mystery", "Comedy", "Slice of Life", "Historical", "Thriller", "Supernatural", "Post-Apocalyptic", "Cyberpunk"],
  relationship: ["Enemies to Lovers", "Friends to Lovers", "Slow Burn", "Forbidden", "Arranged", "Rivals", "Reunion", "Found Family", "Unrequited"],
  dynamic: ["Dominant", "Submissive", "Switch", "Tsundere", "Yandere", "Protective", "Playful", "Cold", "Nurturing", "Mischievous", "Stoic"],
  setting: ["Modern", "School / Academy", "Workplace", "Royal Court", "Space", "Wasteland", "Small Town", "Underworld", "Military", "Academy of Magic", "Open World"],
  themes: ["Angst", "Comfort", "Hurt / Comfort", "Redemption", "Survival", "Power Struggle", "Found Identity", "Revenge", "Mystery Box", "Slice of Peace", "OC", "Fandom"],
  format: ["RPG", "Multiplayer Cast", "Interactive Fiction", "Choose Your Path", "Long Form", "Quick Play"],
};

const categoryById = (id: string) => platformTagCategories.find((category) => category.id === id);

describe("existing taxonomy", () => {
  it("still carries every tag it carried before, in the same category and the same spelling", () => {
    for (const [id, tags] of Object.entries(preexisting)) {
      const category = categoryById(id);
      expect(category, `category ${id} disappeared`).toBeDefined();
      for (const tag of tags) expect(category!.tags, `${id} lost ${tag}`).toContain(tag);
    }
  });

  it("keeps every previously stored tag resolvable, so existing creations keep their filters", () => {
    for (const tag of Object.values(preexisting).flat()) {
      expect(isPlatformTag(tag)).toBe(true);
      expect(canonicalTag(tag.toLowerCase())).toBe(tag);
    }
  });

  it("never lists the same tag twice, however many categories were added", () => {
    const seen = platformTags.map((tag) => tag.toLowerCase());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("does not restate Dominant, Submissive or Switch inside the adult categories", () => {
    for (const tag of ["Dominant", "Submissive", "Switch"]) {
      expect(categoryById("dynamic")!.tags).toContain(tag);
      expect(adultTags).not.toContain(tag);
      // They describe a dynamic that is not inherently adult, so they must not
      // be adult-marked either.
      expect(isAdultTag(tag)).toBe(false);
    }
  });

  it("carries no platform-specific or creator-status labels from anywhere else", () => {
    const foreign = ["Juicy Rising Star", "Juicy Royalty", "Juiciest", "Image Set", "Image Reply", "Persona Card", "Scene Card", "Heatwave Heartache", "Figure"];
    for (const label of foreign) expect(isPlatformTag(label)).toBe(false);
  });
});

describe("new taxonomy", () => {
  it("groups orientation on its own rather than folding it into identity", () => {
    const orientation = categoryById("orientation");
    expect(orientation).toBeDefined();
    expect(orientation!.tags).toEqual(["Straight", "Gay", "Lesbian", "Bisexual", "Pansexual", "Asexual", "Demisexual", "Queer"]);
    // Intersex is a sex characteristic, not an orientation, so it belongs with
    // the other identity tags.
    expect(orientation!.tags).not.toContain("Intersex");
    expect(categoryById("identity")!.tags).toContain("Intersex");
  });

  it("carries the adult tags this sprint added", () => {
    const expected = [
      "Explicit", "Lewd", "Erotic", "Kinky", "Vanilla", "Seductive",
      "BDSM", "Femdom", "Degradation", "Sadistic", "Brat",
      "Breeding", "Pregnancy", "Omegaverse", "Feet / Foot Fetish", "Size Kink", "Group Sex",
      "Cheating", "Cuckold", "Stag", "Bull / Third", "Vixen", "CNC / Non-consent Fantasy",
      "Femboy", "Futanari", "MILF", "DILF", "Petite", "Large Breasts", "Small Breasts", "Large Penis", "Small Penis",
    ];
    for (const tag of expected) {
      expect(isPlatformTag(tag), `${tag} is missing from the taxonomy`).toBe(true);
      expect(isAdultTag(tag), `${tag} is not marked adult`).toBe(true);
    }
  });

  it("names the non-consent tag as a fiction label rather than as an act", () => {
    const tag = adultTags.find((entry) => entry.startsWith("CNC"))!;
    expect(tag).toBe("CNC / Non-consent Fantasy");
    // The word that makes it a roleplay label has to survive any relabelling.
    expect(tag.toLowerCase()).toContain("fantasy");
  });

  it("marks adult tags at the category level so a picker can label every one of them", () => {
    const adultCategories = platformTagCategories.filter((category) => category.adult);
    expect(adultCategories.length).toBeGreaterThan(0);
    expect(adultCategories.flatMap((category) => category.tags).sort()).toEqual([...adultTags].sort());
    for (const category of platformTagCategories.filter((entry) => !entry.adult)) {
      for (const tag of category.tags) expect(isAdultTag(tag), `${tag} is adult-marked outside an adult category`).toBe(false);
    }
  });

  it("reports the adult tags inside a mixed selection", () => {
    expect(adultTagsIn(["Romance", "BDSM", "Slow Burn", "breeding"])).toEqual(["BDSM", "Breeding"]);
    expect(adultTagsIn(["Romance", "Slow Burn"])).toEqual([]);
  });

  it("stays curated rather than becoming a wall", () => {
    // A guard against the taxonomy quietly growing without a decision: every
    // category stays browsable, and adult work does not dominate the list.
    for (const category of platformTagCategories) {
      expect(category.tags.length, `${category.id} has grown too long to browse`).toBeLessThanOrEqual(24);
    }
    expect(adultTags.length).toBeLessThan(platformTags.length / 2);
  });
});

describe("tags and hashtags stay separate systems", () => {
  it("does not promote a hashtag into the taxonomy", () => {
    for (const hashtag of ["mha", "villainau", "studentpov", "bakugo", "officeaffair", "brattysub", "elfkingdom"]) {
      expect(isPlatformTag(hashtag)).toBe(false);
    }
  });

  it("keeps hashtag normalisation independent of the taxonomy", () => {
    expect(normalizeHashtag("#HogwartsAU")).toBe("hogwartsau");
    expect(parseHashtags("#collar #ropeplay, brattysub")).toEqual(["collar", "ropeplay", "brattysub"]);
    // Hashtag normalisation is lossy in ways the taxonomy never is: it
    // lowercases and drops every character a URL cannot carry, so a taxonomy
    // label put through it stops being that label.
    expect(normalizeHashtag("#CNC / Non-consent Fantasy")).toBe("cncnonconsentfantasy");
    expect(platformTags).not.toContain(normalizeHashtag("#CNC / Non-consent Fantasy"));
  });
});

describe("one taxonomy, two surfaces", () => {
  it("serves the studio picker and the discovery filter from the same object", () => {
    // Both import `platformTagCategories`; this asserts there is only one of
    // them to import, so the two surfaces cannot drift apart.
    expect(studioCategories).toBe(platformTagCategories);
  });

  it("offers every creator-selectable tag to the filter as well", () => {
    const filterable = platformTagCategories.flatMap((category) => category.tags);
    expect(filterable).toEqual(platformTags);
  });
});

describe("adult tags and adult mode", () => {
  /*
   * The second argument is now which MODE the creator chose, because that is
   * what the rule is about. The platform's adult tags are its explicitly 18+
   * categories, so they agree with adult_focused and with nothing else —
   * adult_capable is the "may become explicit" case and is not a claim these
   * tags make.
   */
  const withTags = (tags: string[], adult: boolean) => ({
    ...blankDraft,
    title: "A title",
    tags,
    contentMode: adult ? "adult_focused" as const : "clean" as const,
    nsfwEnabled: adult,
  });

  it("refuses to publish adult-tagged work outside the 18+ mode", () => {
    const problems = draftProblems(withTags(["BDSM"], false));
    expect(problems.some((problem) => problem.step === "publish")).toBe(true);
    expect(problems.find((problem) => problem.step === "publish")!.message).toContain("BDSM");
  });

  it("names every disagreeing tag rather than only the first", () => {
    const message = draftProblems(withTags(["Breeding", "Lewd", "Romance"], false)).find((problem) => problem.step === "publish")!.message;
    expect(message).toContain("Breeding");
    expect(message).toContain("Lewd");
    expect(message).not.toContain("Romance");
  });

  it("publishes adult-tagged work once the 18+ mode is chosen", () => {
    expect(draftProblems(withTags(["BDSM", "Femdom"], true)).some((problem) => problem.step === "publish")).toBe(false);
  });

  it("leaves safe work alone", () => {
    expect(draftProblems(withTags(["Romance", "Slow Burn"], false))).toEqual([]);
  });
});

/**
 * The rating a creation is stored with.
 *
 * Discovery decides what to keep out of a feed that has not opted in by reading
 * `nsfw_enabled` alone, so an adult-tagged creation stored as safe would be
 * shown to somebody who asked not to see adult work. The schema both routes
 * parse through is where that is made impossible, rather than the studio, which
 * is only the first of the two places it is enforced.
 */
describe("adult tags cannot bypass the 18+ setting", () => {
  const payload = (changes: Record<string, unknown>) => characterSchema.parse({
    name: "Seraphine", title: "Seraphine", creationType: "character", ...changes,
  });

  it("marks a public creation adult when it carries an adult tag", () => {
    expect(payload({ tags: ["BDSM"], visibility: "public", nsfwEnabled: false }).nsfwEnabled).toBe(true);
  });

  it("marks an unlisted creation adult too, since a link reaches anybody", () => {
    expect(payload({ tags: ["Breeding"], visibility: "unlisted", nsfwEnabled: false }).nsfwEnabled).toBe(true);
  });

  it("is not fooled by casing or by a tag buried in a longer selection", () => {
    expect(payload({ tags: ["Romance", "Slow Burn", "femdom"], visibility: "public", nsfwEnabled: false }).nsfwEnabled).toBe(true);
  });

  it("leaves a safe public creation exactly as its creator set it", () => {
    expect(payload({ tags: ["Romance", "Slow Burn"], visibility: "public", nsfwEnabled: false }).nsfwEnabled).toBe(false);
  });

  it("never turns adult mode off", () => {
    expect(payload({ tags: ["Romance"], visibility: "public", nsfwEnabled: true }).nsfwEnabled).toBe(true);
    expect(payload({ tags: [], visibility: "private", nsfwEnabled: true }).nsfwEnabled).toBe(true);
  });

  it("leaves a private draft alone, since nobody else can reach it", () => {
    // A creator mid-edit keeps their own settings; the rating is decided when
    // the creation is actually shared.
    expect(payload({ tags: ["BDSM"], visibility: "private", nsfwEnabled: false }).nsfwEnabled).toBe(false);
  });

  it("keeps the tags themselves untouched either way", () => {
    expect(payload({ tags: ["BDSM", "Romance"], visibility: "public" }).tags).toEqual(["BDSM", "Romance"]);
  });
});
