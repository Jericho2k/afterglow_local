import { describe, expect, it } from "vitest";
import {
  contentModeBadge, explicitRoleplayAllowed, indexableWithoutAccount, presentsAsAdult,
  readableWithoutAccount, requiresAdultConfirmation, safeShareTitle, shareMedia,
  worldReadableWithoutAccount,
} from "@/lib/content-mode";
import { roleplayPrompt } from "@/lib/prompts";
import { shareImageUrl } from "@/lib/site";
import type { Character } from "@/lib/types";

/**
 * The three questions one boolean used to answer.
 *
 * `nsfw_enabled` meant "may this go explicit", and was then also asked whether
 * a stranger may read the page and whether an image may be a link preview.
 * These assert that the three answers are now independent — and specifically
 * that the middle mode exists: an adult-capable creation is an ordinary public
 * page that writes cleanly until its reader asks otherwise.
 */

const base: Character = {
  id: "1", name: "Mara", creationType: "character", title: "Mara", profileType: "single", tagline: "Art thief",
  description: "", descriptionRich: [], greetingRich: [], alternateGreetingsRich: [], userRole: "", avatarUrl: "", avatarPath: "", accent: "#e879a9",
  backstory: "Mara is 31.", cast: [], lorebook: "", personality: "Dry wit.", scenario: "Paris.", greeting: "Hello.", alternateGreetings: [],
  exampleDialogue: "", responseDirective: "", boundaries: "",
  sourceMaterial: "", worldIds: [], tags: [], hashtags: [], quickFacts: [], gallery: [],
  publicStats: { messages: null, saves: null, chats: null, rank: null, rankCategory: null },
  visibility: "public", ownedByViewer: true, contentMode: "clean", nsfwEnabled: false,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};

const optedIn = { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive" as const, adultConfirmed: true, adultContentEnabled: true };
const confirmedOnly = { ...optedIn, adultContentEnabled: false };
const anonymousReader = { ownerName: "Alex", ownerProfile: "", roleplayPreset: "immersive" as const };

function writerMode(character: Character, settings: Parameters<typeof roleplayPrompt>[4]) {
  const prompt = roleplayPrompt(character, "", [], [], settings);
  return prompt.includes("ADULT MODE:") ? "adult" : prompt.includes("SFW MODE:") ? "sfw" : "neither";
}

describe("adult-capable is readable by everyone and explicit for nobody by default", () => {
  const capable = { ...base, contentMode: "adult_capable" as const };

  it("keeps its public page open to a reader who has confirmed nothing", () => {
    // The whole point of the middle mode: capability to go explicit is not a
    // reason to hide the page from a logged-out visitor or a search engine.
    expect(readableWithoutAccount(capable.contentMode)).toBe(true);
    expect(indexableWithoutAccount(capable.contentMode)).toBe(true);
    expect(requiresAdultConfirmation(capable.contentMode)).toBe(false);
  });

  it("writes a non-explicit scene for a reader who has not opted in", () => {
    expect(writerMode(capable, anonymousReader)).toBe("sfw");
    // Confirming an age is not the same as asking for explicit content, so a
    // reader who did only the first still gets a clean scene.
    expect(writerMode(capable, confirmedOnly)).toBe("sfw");
    expect(explicitRoleplayAllowed(capable.contentMode, { confirmedAdult: true, adultContentEnabled: false })).toBe(false);
  });

  it("writes an explicit scene once the reader has confirmed and opted in", () => {
    expect(writerMode(capable, optedIn)).toBe("adult");
    expect(explicitRoleplayAllowed(capable.contentMode, { confirmedAdult: true, adultContentEnabled: true })).toBe(true);
  });

  it("carries no 18+ badge and is not what the discovery filter excludes", () => {
    // `presentsAsAdult` is the single predicate every badge and the feed's
    // adult filter read. Adult-capable must not be inside it, or the mode
    // collapses back into the boolean it replaced.
    expect(presentsAsAdult(capable.contentMode)).toBe(false);
    expect(contentModeBadge(capable.contentMode)).not.toBe("18+");
    expect(presentsAsAdult("adult_focused")).toBe(true);
    expect(contentModeBadge("adult_focused")).toBe("18+");
  });
});

describe("adult-focused is gated until an age is confirmed", () => {
  const focused = { ...base, contentMode: "adult_focused" as const };

  it("has no page without an account, only a safe landing", () => {
    expect(readableWithoutAccount(focused.contentMode)).toBe(false);
    expect(requiresAdultConfirmation(focused.contentMode)).toBe(true);
    // The gate is a real page that may be linked, and deliberately not one a
    // crawler is invited to keep.
    expect(indexableWithoutAccount(focused.contentMode)).toBe(false);
  });

  it("opens and writes explicitly for a confirmed, opted-in reader", () => {
    expect(explicitRoleplayAllowed(focused.contentMode, { confirmedAdult: true, adultContentEnabled: true })).toBe(true);
    expect(writerMode(focused, optedIn)).toBe("adult");
  });

  it("stays non-explicit for a confirmed reader who has not asked for it", () => {
    // Reaching the page is an age question; how it writes is a preference.
    expect(writerMode(focused, confirmedOnly)).toBe("sfw");
  });
});

describe("clean never becomes explicit", () => {
  it("ignores every reader setting", () => {
    expect(explicitRoleplayAllowed("clean", { confirmedAdult: true, adultContentEnabled: true })).toBe(false);
    expect(writerMode(base, optedIn)).toBe("sfw");
  });
});

describe("worlds are excluded until their creator classifies them", () => {
  it("treats an unclassified world as unpublished rather than clean", () => {
    // A world carries no legacy flag to translate, so "we have never asked"
    // must not resolve to "safe for everybody".
    expect(worldReadableWithoutAccount(null)).toBe(false);
    expect(worldReadableWithoutAccount(undefined)).toBe(false);
    expect(worldReadableWithoutAccount("clean")).toBe(true);
    expect(worldReadableWithoutAccount("adult_capable")).toBe(true);
    expect(worldReadableWithoutAccount("adult_focused")).toBe(false);
  });
});

describe("only reviewed media leaves Afterglow", () => {
  const nominated = { shareImagePath: "users/abc/share.png", avatarPath: "users/abc/cover.png" };

  it("refuses unreviewed, adult and rejected media", () => {
    // Nomination is the creator's act; classification is the platform's. An
    // image nobody has classified is not a preview, however it was nominated.
    expect(shareMedia({ ...nominated, status: "unreviewed" })).toEqual({ kind: "fallback" });
    expect(shareMedia({ ...nominated, status: "adult" })).toEqual({ kind: "fallback" });
    expect(shareMedia({ ...nominated, status: "rejected" })).toEqual({ kind: "fallback" });
    // An absent status is unreviewed, so a row that predates the column, or a
    // caller that forgets to pass it, produces the branded card.
    expect(shareMedia(nominated)).toEqual({ kind: "fallback" });
  });

  it("never lets an unreviewed cover reach an OG tag", () => {
    const url = shareImageUrl(shareMedia({ ...nominated, status: "unreviewed" }), "character-avatars", "#e879a9");
    expect(url).toContain("/api/og/card");
    expect(url).not.toContain("share.png");
    expect(url).not.toContain("cover.png");
  });

  it("uses the nominated image once it is classified safe", () => {
    expect(shareMedia({ ...nominated, status: "safe" })).toEqual({ kind: "storage", path: "users/abc/share.png" });
    // The gallery is never a candidate in any status: it is not in the source.
    expect(shareMedia({ status: "safe", avatarPath: "users/abc/cover.png" })).toEqual({ kind: "storage", path: "users/abc/cover.png" });
  });
});

describe("an explicit title cannot leak through a gate", () => {
  it("never uses the page title for an adult-focused creation", () => {
    const title = safeShareTitle({
      contentMode: "adult_focused",
      title: "Explicit page title nobody nominated",
      name: "Explicit name",
      creatorUsername: "mara",
    });
    expect(title).toBe("18+ creation by @mara");
    expect(title).not.toContain("Explicit");
  });

  it("falls back to platform copy when there is no creator to name", () => {
    expect(safeShareTitle({ contentMode: "adult_focused", title: "Explicit", name: "Explicit" }))
      .toBe("18+ creation on Afterglow");
  });

  it("uses the nominated safe title when the creator wrote one", () => {
    expect(safeShareTitle({ contentMode: "adult_focused", shareTitle: "Mara", title: "Explicit", creatorUsername: "mara" }))
      .toBe("Mara");
  });

  it("uses the real title for a creation whose page is already public", () => {
    // Nothing is being protected here — the page is readable by anybody — so
    // withholding the title would only make the search result useless.
    expect(safeShareTitle({ contentMode: "adult_capable", title: "The Paris Job", name: "Mara" })).toBe("The Paris Job");
    expect(safeShareTitle({ contentMode: "clean", title: "", name: "Mara" })).toBe("Mara");
  });
});
