import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { artPresentation, bannerArt } from "@/lib/art-presentation";

const migration = readFileSync(new URL("../supabase/migrations/0037_art_presentation_and_links.sql", import.meta.url), "utf8");
const linked = readFileSync(new URL("../supabase/migrations/0017_linked_world_previews.sql", import.meta.url), "utf8");
const shareCards = readFileSync(new URL("../supabase/migrations/0039_share_card_artwork.sql", import.meta.url), "utf8");

/**
 * The same creation looks the same to everybody who may see it.
 *
 * A creator sets a focal point once. If the anonymous page reaches a different
 * conclusion from the signed-in page — because it reads different columns, or
 * because a second component re-derives the crop for itself — then the visitor
 * arriving from a search result sees a different creation from the member who
 * shared it, and the creator's decision only applied to half the audience.
 */

describe("anonymous and authenticated framing come from one decision", () => {
  const art = {
    avatarPath: "cover.png",
    avatarUrl: "",
    bannerPath: "",
    bannerUrl: "",
    presentation: artPresentation({ v: 1, cover: { focal: { x: 0.2, y: 0.15 } } }),
  };

  it("resolves identically from either page's data", () => {
    // The signed-in page passes a `Character`; the public page passes its view
    // model's `art` block. Both call `bannerArt`, which is the only place the
    // decision is made — so the same inputs cannot produce two answers.
    const authenticated = bannerArt(art);
    const anonymous = bannerArt({ ...art });
    expect(anonymous).toEqual(authenticated);
    expect(anonymous.style).toEqual({ objectPosition: "20% 15%" });
  });

  it("agrees about the banner fallback too", () => {
    const withBanner = { ...art, bannerPath: "wide.png", presentation: artPresentation({ v: 1, banner: { focal: { x: 0.8, y: 0.4 } } }) };
    expect(bannerArt(withBanner).path).toBe("wide.png");
    expect(bannerArt(withBanner).style).toEqual({ objectPosition: "80% 40%" });
  });

  it("ships the framing columns on every public function that ships artwork", () => {
    /*
     * The structural half of the same guarantee. A public function that
     * returned `avatar_path` without `art_presentation` would render a
     * correctly-chosen image at the wrong crop, and nothing in the TypeScript
     * would notice — the field would simply be undefined and the style empty.
     */
    for (const fn of ["public_creation_page", "public_creation_card", "public_creator_creations"]) {
      const start = migration.indexOf(`CREATE FUNCTION public.${fn}`);
      expect(start, `${fn} is defined`).toBeGreaterThan(-1);
      const body = migration.slice(start, migration.indexOf("$$;", start));
      expect(body, `${fn} carries banner_path`).toContain("banner_path");
      expect(body, `${fn} carries art_presentation`).toContain("art_presentation");
    }
  });

  it("still refuses to send a gated creation's artwork at all", () => {
    // The creator shelf blanks a gated row's art rather than framing it: the
    // shelf draws nominated share media there, and an unnominated one gets the
    // branded card. Framing an image that must not be shown would be worse
    // than useless.
    const start = migration.indexOf("CREATE FUNCTION public.public_creator_creations");
    const body = migration.slice(start, migration.indexOf("$$;", start));
    expect(body).toContain("THEN '' ELSE c.banner_path END");
    expect(body).toContain("THEN '{}'::jsonb ELSE c.art_presentation END");
  });

  it("frames the safe landing's artwork too, once it has any", () => {
    /*
     * 0037 left the safe landing out of this deliberately: a gate showed
     * nominated share media or a branded card and never the creation's own
     * art, so framing data would have had nothing to render. 0039 changed the
     * premise — an OPEN creation's card now composites the artwork its page
     * already shows — so the framing has to travel with it, and the assertion
     * moves with the premise rather than being deleted.
     *
     * It is still absent from 0037, which redefines nothing about that
     * function; the columns arrive in the migration that gives it artwork.
     */
    expect(migration).not.toContain("CREATE FUNCTION public.public_creation_safe_landing");

    const start = shareCards.indexOf("CREATE FUNCTION public.public_creation_safe_landing");
    expect(start, "0039 defines the safe landing").toBeGreaterThan(-1);
    const body = shareCards.slice(start, shareCards.indexOf("$$;", start));
    expect(body).toContain("art_presentation jsonb");
    // And a gated creation still has nothing to frame, which is why its
    // framing column is blanked rather than merely unread.
    expect(body).toContain("CASE WHEN c.content_mode = 'adult_focused' THEN '{}'::jsonb ELSE c.art_presentation END");
  });

  it("frames an external card from the same document, not from a constant", () => {
    // The last surface still cropping at a hardcoded point. A creator who set a
    // focal point in the studio and then watched the share card behead their
    // artwork would reasonably conclude the control does not work.
    const card = readFileSync(new URL("../src/lib/og-card.ts", import.meta.url), "utf8");
    expect(card).toContain('objectPosition(landing.openArt.presentation, "cover", "16:9")');
    const render = readFileSync(new URL("../src/lib/og-card-render.tsx", import.meta.url), "utf8");
    expect(render).toContain("objectPosition: card.artworkPosition");
    expect(render).not.toContain('objectPosition: "50% 32%"');
  });
});

/**
 * Locked world previews, which this change must not disturb.
 *
 * A public creation built on a private world shows the association without
 * showing its content: row level security refuses the world row, and a narrow
 * four-column function supplies the card. That behaviour predates this work
 * (migration 0017) and its own tests live in tenancy.test.ts. These assertions
 * exist so that a later edit to the presentation functions cannot quietly widen
 * or replace it — the failure mode being guarded is somebody "helpfully"
 * teaching the preview about banners.
 */
describe("private attached worlds stay associated and unopenable", () => {
  it("keeps the preview to exactly four columns", () => {
    const signature = linked.slice(linked.indexOf("RETURNS TABLE"), linked.indexOf("LANGUAGE sql"));
    expect(signature).toContain("id uuid");
    expect(signature).toContain("name text");
    expect(signature).toContain("cover_path text");
    expect(signature).toContain("cover_url text");
    // No lore, no description, no owner, and now: no framing either.
    expect(signature).not.toContain("content");
    expect(signature).not.toContain("art_presentation");
    expect(signature).not.toContain("banner");
  });

  it("is not redefined by the presentation migration", () => {
    expect(migration).not.toContain("creation_world_previews");
  });
});
