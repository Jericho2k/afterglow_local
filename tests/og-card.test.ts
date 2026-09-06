import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultArtworkPosition, ogCardArtwork, ogCardModel, ogCardUrl } from "@/lib/og-card";
import { artPresentation } from "@/lib/art-presentation";
import { openCardMedia, shareMedia } from "@/lib/content-mode";
import type { PublicSafeLanding } from "@/lib/public-view";
import type { ContentMode } from "@/lib/types";

/**
 * What a shared link looks like from the outside.
 *
 * Two rules pull in opposite directions here and both have to hold. The card
 * must be a preview of a CREATION — a stranger seeing it in a group chat
 * should be able to tell one from another — and it must never carry a word or a
 * pixel that the creation's content mode does not let out. The previous card
 * satisfied the second by satisfying nothing: every creation in the catalogue
 * produced the same logo, because nothing writes `share_media_status = 'safe'`
 * on its own and the artwork rule waited for it in every mode.
 *
 * These assert the model rather than the PNG, because the model is where every
 * decision is made. The renderer has none left.
 */

// Storage URLs are built from the deployment's Supabase origin; without one
// `avatarSource` correctly resolves to "no image", which is not what these
// cases are about.
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://storage.test";

const bucket = "character-avatars";
const creatorBucket = "profile-avatars";
const cover = "users/alice/avatars/cover.png";
const nominated = "users/alice/avatars/share.png";
const face = "users/alice/avatars/me.png";

type LandingOptions = Partial<PublicSafeLanding> & {
  status?: "unreviewed" | "safe" | "adult" | "rejected";
  sharePath?: string;
  shareUrl?: string;
  avatarPath?: string;
  avatarUrl?: string;
  creatorAvatarPath?: string;
  presentation?: unknown;
};

/**
 * A landing built the way `publicSafeLanding` builds one.
 *
 * Including the blanking: an adult-focused row's `open*` columns come back
 * empty from SQL, so this empties them too rather than letting a test assert a
 * refusal the database would already have made impossible.
 */
function landing(overrides: LandingOptions = {}): PublicSafeLanding {
  const {
    status = "unreviewed", sharePath = "", shareUrl = "", avatarPath = cover, avatarUrl = "",
    creatorAvatarPath = face, presentation, ...rest
  } = overrides;
  const mode: ContentMode = rest.contentMode ?? "clean";
  const gated = mode === "adult_focused";
  const openSharePath = gated ? "" : sharePath;
  const openShareUrl = gated ? "" : shareUrl;
  return {
    id: "aaaaaaaa-0000-4000-8000-000000000001",
    name: "Seraphine",
    title: "Seraphine of the Long Quay",
    shareTitle: "",
    shareTagline: "",
    accent: "#e879a9",
    contentMode: mode,
    creationType: "character",
    share: shareMedia({ shareImagePath: sharePath, shareImageUrl: shareUrl, status, avatarPath, avatarUrl }),
    openArt: {
      media: openCardMedia({
        contentMode: mode,
        shareImagePath: openSharePath,
        shareImageUrl: openShareUrl,
        status,
        avatarPath: gated ? "" : avatarPath,
        avatarUrl: gated ? "" : avatarUrl,
      }),
      isCover: !openSharePath && !openShareUrl,
      presentation: artPresentation(gated ? {} : presentation),
    },
    creator: { username: "alice", displayName: "Alice", avatarPath: creatorAvatarPath },
    ...rest,
  };
}

const card = (options?: LandingOptions) => ogCardModel(landing(options), bucket, creatorBucket);

describe("a card says which creation it is", () => {
  it("names the creation, its creator and its structure", () => {
    const model = card({ status: "safe" });
    expect(model.title).toBe("Seraphine of the Long Quay");
    expect(model.handle).toBe("@alice");
    expect(model.type).toBe("Character");
  });

  it("distinguishes two creations that used to share one picture", () => {
    // The whole complaint: an unreviewed cast and an unreviewed scenario were
    // the same image. They now differ in every field the card draws — and both
    // of them now carry their own artwork as well.
    const cast = card({ creationType: "cast", title: "The Wayfarers", name: "The Wayfarers", accent: "#66ccff" });
    const scenario = card({ creationType: "scenario", title: "The Final War", name: "The Final War" });
    expect(cast.type).toBe("Cast");
    expect(scenario.type).toBe("Scenario");
    expect(cast.title).not.toBe(scenario.title);
    expect(cast.accent).not.toBe(scenario.accent);
  });

  it("prefers the creator's outward-facing copy where they wrote it", () => {
    const model = card({ shareTitle: "Slow burn", shareTagline: "A quiet, unhurried romance." });
    expect(model.title).toBe("Slow burn");
    expect(model.tagline).toBe("A quiet, unhurried romance.");
  });

  it("bounds what it will print, because nothing reflows in a rendered card", () => {
    const model = card({ shareTitle: "A".repeat(200), shareTagline: "B".repeat(400) });
    expect(model.title.length).toBeLessThanOrEqual(64);
    expect(model.tagline.length).toBeLessThanOrEqual(104);
    expect(model.title.endsWith("…")).toBe(true);
  });
});

/**
 * The V1 rule this release exists for.
 *
 * A clean creation's artwork is on a page anonymous visitors and search engines
 * already read, one click behind the link being previewed. Withholding it from
 * the preview until a moderator worked a queue protected nothing and made every
 * ordinary share the same artless card.
 */
describe("an open creation's card is led by its own artwork", () => {
  it("uses the primary artwork with no classification at all", () => {
    const model = card({ status: "unreviewed" });
    expect(model.artwork).toContain(cover);
    // Composed, not handed over: the crawler still stores Afterglow's card.
    expect(model.title).toBe("Seraphine of the Long Quay");
    expect(model.handle).toBe("@alice");
  });

  it("does the same for an adult-capable creation, and still does not call it 18+", () => {
    const model = card({ contentMode: "adult_capable" });
    expect(model.artwork).toContain(cover);
    // Adult-CAPABLE is not an 18+ page, and its card must not present as one:
    // that conflation is what content modes exist to end. Media safety and
    // roleplay capability stay separate questions.
    expect(model.adult).toBe(false);
  });

  it("prefers an image the creator nominated for sharing over the cover", () => {
    const model = card({ sharePath: nominated });
    expect(model.artwork).toContain(nominated);
    expect(model.artwork).not.toContain(cover);
  });

  it("still obeys a moderator who has looked and said no", () => {
    // Only `unreviewed` is treated differently. A decision that an image is
    // adult or unsuitable withholds it here exactly as it always has, which is
    // the seam automated classification would later tighten.
    for (const status of ["adult", "rejected"] as const) {
      expect(card({ status }).artwork, status).toBe("");
    }
    expect(card({ status: "safe" }).artwork).toContain(cover);
  });

  it("crops toward the point its creator chose", () => {
    const model = card({ presentation: { v: 1, cover: { focal: { x: 0.28, y: 0.18 } } } });
    expect(model.artworkPosition).toBe("28% 18%");
  });

  it("falls back to the upper third only where the creator said nothing", () => {
    expect(card().artworkPosition).toBe(defaultArtworkPosition);
    // A separately nominated share image is a different picture, so the cover's
    // focal point does not travel to it.
    expect(card({ sharePath: nominated, presentation: { v: 1, cover: { focal: { x: 0.28, y: 0.18 } } } }).artworkPosition)
      .toBe(defaultArtworkPosition);
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
  const gated = (options: LandingOptions = {}) => landing({
    contentMode: "adult_focused",
    // What the SQL actually returns for a gated row: name and title blanked at
    // the source, so even a mistake downstream has nothing to reach for.
    name: "",
    title: "",
    ...options,
  });

  it("falls back to the neutral line naming only the creator", () => {
    const model = ogCardModel(gated(), bucket, creatorBucket);
    expect(model.title).toBe("18+ creation by @alice");
    expect(model.tagline).toBe("");
    expect(model.adult).toBe(true);
  });

  it("uses the outward copy its creator wrote, and only that", () => {
    const model = ogCardModel(gated({ shareTitle: "Slow burn", shareTagline: "A quiet, unhurried romance." }), bucket, creatorBucket);
    expect(model.title).toBe("Slow burn");
    expect(model.tagline).toBe("A quiet, unhurried romance.");
    expect(model.adult).toBe(true);
  });

  it("never takes the widened path an open creation takes", () => {
    /*
     * The regression this release could most easily have introduced: teaching
     * the card to draw a creation's own artwork, and teaching it to every mode.
     * A gated creation's cover is unreviewed like everybody else's, and it must
     * still produce nothing.
     */
    const model = ogCardModel(gated({ status: "unreviewed", avatarPath: cover }), bucket, creatorBucket);
    expect(model.artwork).toBe("");
    expect(model.artworkPosition).toBe(defaultArtworkPosition);
  });

  it("is refused by the media rule even when handed an unblanked row", () => {
    // Belt and braces, stated as a unit: the SQL blanks the columns AND the
    // rule refuses the mode, so a database that predates 0039 is still safe.
    expect(openCardMedia({ contentMode: "adult_focused", status: "unreviewed", avatarPath: cover })).toEqual({ kind: "fallback" });
    expect(openCardMedia({ contentMode: "adult_focused", status: "safe", avatarPath: cover })).toEqual({ kind: "fallback" });
  });

  it("may still show media a moderator classified safe, without exposing its cover", () => {
    /*
     * The one door a gated creation has, and it is the classified one. The
     * `share` value below is what `shareMedia` returns for an approved
     * nomination; the `openArt` half stays empty, so nothing about the
     * creation's ordinary presentation — its cover, its framing — is reachable
     * even while its approved image is on the card.
     */
    const approved = gated({ status: "safe", sharePath: nominated });
    const model = ogCardModel(approved, bucket, creatorBucket);
    expect(model.artwork).toContain(nominated);
    expect(approved.openArt.media).toEqual({ kind: "fallback" });
    expect(approved.openArt.presentation).toEqual({});
    expect(model.artwork).not.toContain(cover);
    expect(model.adult).toBe(true);
  });

  it("marks itself 18+ where an open creation does not", () => {
    expect(card({ contentMode: "clean" }).adult).toBe(false);
    expect(card({ contentMode: "adult_capable" }).adult).toBe(false);
    expect(ogCardModel(gated(), bucket, creatorBucket).adult).toBe(true);
  });
});

describe("the corner belongs to the creator, not to a letter", () => {
  it("carries the creator's public profile picture", () => {
    const model = card();
    expect(model.creatorAvatar).toBe(`https://storage.test/storage/v1/object/public/profile-avatars/${face}`);
  });

  it("resolves it through the profile avatar bucket, not the creation's", () => {
    expect(card().creatorAvatar).toContain("/profile-avatars/");
    expect(card().creatorAvatar).not.toContain("/character-avatars/");
  });

  it("shows it on a gated card too, because it identifies the creator", () => {
    // The creation is 18+; the person who made it is not gated, and their
    // profile page already shows this picture to anybody.
    const model = ogCardModel(landing({ contentMode: "adult_focused", name: "", title: "" }), bucket, creatorBucket);
    expect(model.creatorAvatar).toContain(face);
  });

  it("simply omits it when the creator has no picture", () => {
    expect(card({ creatorAvatarPath: "" }).creatorAvatar).toBe("");
    expect(card({ creatorAvatarPath: "   " }).creatorAvatar).toBe("");
  });

  it("derives no initial from anything, in any mode", () => {
    /*
     * The boxed letter is gone as a concept rather than as a rendering. Nothing
     * in the model or the composition may reconstruct one: a title's initial
     * repeats what is already printed beside it, and a gated creation's title
     * may not leave at all.
     */
    for (const source of ["../src/lib/og-card.ts", "../src/lib/og-card-render.tsx", "../src/app/api/og/card/route.tsx"]) {
      const text = readFileSync(new URL(source, import.meta.url), "utf8");
      expect(text, source).not.toContain("monogram");
      expect(text, source).not.toContain("initials");
    }
    expect(Object.keys(card())).not.toContain("monogram");
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

  it("gains the open artwork and the creator without gaining a gated cover", () => {
    /*
     * The structural half of every rule above. 0039 redefines
     * `public_creation_safe_landing`, and the shape of that redefinition is
     * what makes an adult-focused creation's widening impossible rather than
     * merely unimplemented: each new artwork column is blanked by a CASE, while
     * the classified columns it already had are untouched.
     */
    const migration = readFileSync(new URL("../supabase/migrations/0039_share_card_artwork.sql", import.meta.url), "utf8");
    const start = migration.indexOf("CREATE FUNCTION public.public_creation_safe_landing");
    const body = migration.slice(start, migration.indexOf("$$;", start));

    for (const column of ["open_share_image_path", "open_share_image_url", "open_avatar_path", "open_avatar_url"]) {
      expect(body, column).toContain(`CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.${column.replace(/^open_/, "")} END`);
    }
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '{}'::jsonb ELSE c.art_presentation END");
    // The classified path is unchanged and still travels for every mode: it is
    // the only way an approved gated image reaches a card.
    expect(body).toContain("c.share_image_path, c.share_image_url, c.share_media_status,");
    expect(body).toContain("c.avatar_path, c.avatar_url,");
    // The creator's picture, for every mode.
    expect(body).toContain("creator_avatar_path text");
    expect(body).toContain("COALESCE(p.avatar_path, '')");
    // And the blanking that makes a gated row safe at the source survives the
    // redefinition rather than being lost in it.
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.name END");
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '' ELSE c.title END");
    expect(migration).toContain("GRANT EXECUTE ON FUNCTION public.public_creation_safe_landing(uuid) TO anon, authenticated;");
  });

  it("adds no other profile field to the safe landing", () => {
    /*
     * The narrow public shape stays narrow. A creator's avatar is the ONE field
     * this release needed; a bio, a cover, a follower count or an id would each
     * be a private-by-default surface widened for a picture.
     */
    const migration = readFileSync(new URL("../supabase/migrations/0039_share_card_artwork.sql", import.meta.url), "utf8");
    const signature = migration.slice(migration.indexOf("RETURNS TABLE"), migration.indexOf("LANGUAGE sql"));
    const profileColumns = [...signature.matchAll(/creator_(\w+)/g)].map((match) => match[1]);
    expect(profileColumns.sort()).toEqual(["avatar_path", "display_name", "username"]);

    const model = landing();
    expect(Object.keys(model.creator).sort()).toEqual(["avatarPath", "displayName", "username"]);
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
