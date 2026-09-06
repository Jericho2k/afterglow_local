import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ogCardArtwork, ogCardModel, ogCardUrl } from "@/lib/og-card";
import { shareMedia } from "@/lib/content-mode";
import type { PublicSafeLanding } from "@/lib/public-view";

/**
 * What a shared link looks like from the outside.
 *
 * Two rules pull in opposite directions here and both have to hold. The card
 * must be a preview of a CREATION — a stranger seeing it in a group chat
 * should be able to tell one from another — and it must never carry a word or a
 * pixel that the creation's content mode does not let out. The previous card
 * satisfied the second by satisfying nothing: every creation in the catalogue
 * produced the same logo.
 *
 * These assert the model rather than the PNG, because the model is where every
 * decision is made. The renderer has none left.
 */

// Storage URLs are built from the deployment's Supabase origin; without one
// `avatarSource` correctly resolves to "no image", which is not what these
// cases are about.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.test";

const bucket = "character-avatars";
const cover = "users/alice/avatars/cover.png";
const nominated = "users/alice/avatars/share.png";

function landing(overrides: Partial<PublicSafeLanding> & { status?: "unreviewed" | "safe" | "adult" | "rejected"; sharePath?: string; shareUrl?: string; avatarPath?: string; avatarUrl?: string } = {}): PublicSafeLanding {
  const { status = "unreviewed", sharePath = "", shareUrl = "", avatarPath = cover, avatarUrl = "", ...rest } = overrides;
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Seraphine",
    title: "Seraphine of the Long Quay",
    shareTitle: "",
    shareTagline: "",
    accent: "#e879a9",
    contentMode: "clean",
    creationType: "character",
    share: shareMedia({ shareImagePath: sharePath, shareImageUrl: shareUrl, status, avatarPath, avatarUrl }),
    creator: { username: "alice", displayName: "Alice" },
    ...rest,
  };
}

describe("a card says which creation it is", () => {
  it("names the creation, its creator and its structure", () => {
    const card = ogCardModel(landing({ status: "safe" }), bucket);
    expect(card.title).toBe("Seraphine of the Long Quay");
    expect(card.handle).toBe("@alice");
    expect(card.type).toBe("Character");
  });

  it("distinguishes two creations that used to share one picture", () => {
    // The whole complaint: an unreviewed cast and an unreviewed scenario were
    // the same image. They now differ in every field the card draws.
    const cast = ogCardModel(landing({ creationType: "cast", title: "The Wayfarers", name: "The Wayfarers", accent: "#66ccff" }), bucket);
    const scenario = ogCardModel(landing({ creationType: "scenario", title: "The Final War", name: "The Final War" }), bucket);
    expect(cast.artwork).toBe("");
    expect(scenario.artwork).toBe("");
    expect(cast.type).toBe("Cast");
    expect(scenario.type).toBe("Scenario");
    expect(cast.title).not.toBe(scenario.title);
    expect(cast.monogram).toBe("T");
    expect(cast.accent).not.toBe(scenario.accent);
  });

  it("prefers the creator's outward-facing copy where they wrote it", () => {
    const card = ogCardModel(landing({ shareTitle: "Slow burn", shareTagline: "A quiet, unhurried romance." }), bucket);
    expect(card.title).toBe("Slow burn");
    expect(card.tagline).toBe("A quiet, unhurried romance.");
  });

  it("bounds what it will print, because nothing reflows in a rendered card", () => {
    const card = ogCardModel(landing({ shareTitle: "A".repeat(200), shareTagline: "B".repeat(400) }), bucket);
    expect(card.title.length).toBeLessThanOrEqual(64);
    expect(card.tagline.length).toBeLessThanOrEqual(104);
    expect(card.title.endsWith("…")).toBe(true);
  });
});

describe("classification decides whether artwork appears", () => {
  it("composes around approved artwork rather than handing it over", () => {
    const card = ogCardModel(landing({ status: "safe", sharePath: nominated }), bucket);
    expect(card.artwork).toContain(nominated);
    // Still a card: the title and creator are on it, so what a crawler stores
    // is Afterglow's rendering rather than the creator's file.
    expect(card.title).toBe("Seraphine of the Long Quay");
    expect(card.handle).toBe("@alice");
  });

  it("draws no artwork at all for anything not classified safe", () => {
    for (const status of ["unreviewed", "adult", "rejected"] as const) {
      const card = ogCardModel(landing({ status, sharePath: nominated }), bucket);
      expect(card.artwork, status).toBe("");
      // …and the card is still that creation's, which is the half that was
      // missing: a fallback used to mean an identical logo.
      expect(card.title, status).toBe("Seraphine of the Long Quay");
      expect(card.monogram, status).toBe("S");
    }
  });

  it("will not fetch an artwork URL that is not an image on the public web", () => {
    // Rendering means THIS SERVER makes the request, and a nominated external
    // URL is creator-supplied text.
    expect(ogCardArtwork({ kind: "external", url: "http://10.0.0.1/internal.png" })).toBe("");
    expect(ogCardArtwork({ kind: "external", url: "file:///etc/passwd" })).toBe("");
    expect(ogCardArtwork({ kind: "external", url: " javascript:alert(1)" })).toBe("");
    expect(ogCardArtwork({ kind: "external", url: "https://example.test/art.png" })).toBe("https://example.test/art.png");
    // A legacy imported card's inline image makes no request at all.
    expect(ogCardArtwork({ kind: "external", url: "data:image/png;base64,AAAA" })).toBe("data:image/png;base64,AAAA");
    expect(ogCardArtwork({ kind: "fallback" })).toBe("");
  });
});

describe("an adult-focused creation borrows nothing from its page", () => {
  const gated = () => landing({
    contentMode: "adult_focused",
    // What the SQL actually returns for a gated row: name and title blanked at
    // the source, so even a mistake downstream has nothing to reach for.
    name: "",
    title: "",
  });

  it("falls back to the neutral line naming only the creator", () => {
    const card = ogCardModel(gated(), bucket);
    expect(card.title).toBe("18+ creation by @alice");
    expect(card.tagline).toBe("");
    expect(card.adult).toBe(true);
    // No initial, because the only title it could be derived from is one that
    // may not leave.
    expect(card.monogram).toBe("");
  });

  it("uses the outward copy its creator wrote, and only that", () => {
    const card = ogCardModel({ ...gated(), shareTitle: "Slow burn", shareTagline: "A quiet, unhurried romance." }, bucket);
    expect(card.title).toBe("Slow burn");
    expect(card.tagline).toBe("A quiet, unhurried romance.");
    expect(card.adult).toBe(true);
  });

  it("still refuses unclassified artwork, which is the rule that predates this card", () => {
    const card = ogCardModel({ ...gated(), share: shareMedia({ status: "unreviewed", avatarPath: cover }) }, bucket);
    expect(card.artwork).toBe("");
  });

  it("marks itself 18+ where an open creation does not", () => {
    expect(ogCardModel(landing({ contentMode: "clean" }), bucket).adult).toBe(false);
    // Adult-CAPABLE is not an 18+ page, and its card must not present as one:
    // that conflation is what content modes exist to end.
    expect(ogCardModel(landing({ contentMode: "adult_capable" }), bucket).adult).toBe(false);
    expect(ogCardModel(gated(), bucket).adult).toBe(true);
  });
});

describe("the preview is a rendering rather than a file", () => {
  it("points every creation's preview at the composing route", () => {
    expect(ogCardUrl("aaaaaaaa-0000-4000-8000-000000000001")).toContain("/api/og/card?id=aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("is what the creation page's metadata actually uses", () => {
    const page = readFileSync(new URL("../src/app/characters/[id]/page.tsx", import.meta.url), "utf8");
    expect(page).toContain("const image = ogCardUrl(landing.id)");
    // The raw-artwork helper is gone from this page. It still serves worlds and
    // creator profiles, which have no composed card of their own yet.
    expect(page).not.toContain("shareImageUrl");
  });

  it("gains structure from the safe landing without gaining artwork", () => {
    /*
     * 0038 redefines `public_creation_safe_landing` to add the creation's
     * structure. The rule it must not break is the one 0037 established: the
     * gate — and therefore the preview built from it — shows nominated share
     * media or a branded card, never the creation's own art, so framing data
     * there would have nothing to render and would be a column worth removing.
     */
    const migration = readFileSync(new URL("../supabase/migrations/0038_share_media_review.sql", import.meta.url), "utf8");
    const start = migration.indexOf("CREATE FUNCTION public.public_creation_safe_landing");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("creation_type");
    expect(body).not.toContain("banner_path");
    expect(body).not.toContain("art_presentation");
    // And the blanking that makes a gated row safe at the source survives the
    // redefinition rather than being lost in it.
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.name END");
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.title END");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.public_creation_safe_landing(uuid) TO anon, authenticated;");
  });

  it("takes no text from the query string", () => {
    /*
     * The property the original fallback card was built around, and the reason
     * it refused to print anything: a route that renders words from its URL is
     * a renderer for anybody's words, and the creations relying on it most are
     * the gated ones. It survives the redesign because the card is resolved
     * from an id through the anonymous view model instead.
     */
    const route = readFileSync(new URL("../src/app/api/og/card/route.tsx", import.meta.url), "utf8");
    const params = [...route.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((match) => match[1]);
    expect(params.sort()).toEqual(["accent", "id"]);
    expect(route).toContain("publicSafeLanding(id)");
  });
});
