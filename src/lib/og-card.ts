import { normalizeAccent } from "./accent";
import { objectPosition } from "./art-presentation";
import { readableWithoutAccount, safeShareTitle } from "./content-mode";
import type { PublicSafeLanding } from "./public-view";
import { absoluteUrl } from "./site";
import { avatarSource, characterAvatarBucket, profileAvatarBucket } from "./storage";
import type { CreationType } from "./types";

/**
 * What a link preview of a creation may say and show.
 *
 * The card this produces is the first — and for an adult-focused creation, the
 * only — thing most people ever see of a creation: a Discord embed, a search
 * result, a message in a group chat. Until now every one of them was the same
 * picture. Two completely different creations produced identical previews,
 * because the fallback card carried the wordmark and nothing else, and the
 * "safe" path handed over the raw artwork with no Afterglow anywhere on it.
 * Neither is a preview of a CREATION.
 *
 * This module is the model; `src/app/api/og/card/route.tsx` draws it. They are
 * separate so that the rules — which words may leave, which image may leave —
 * are testable without rendering a PNG, and so the drawing code has no
 * decisions left in it.
 *
 * THE RULES, none of which this module invents:
 *
 *   * An adult-focused creation's artwork appears only when the platform has
 *     classified the nominated media `safe`. That decision is `shareMedia`,
 *     made once, before this is called, and this module cannot reach past it —
 *     it is handed a resolved `ShareMedia` and an unreviewed one carries no
 *     path to draw.
 *   * A creation whose page is already readable without an account draws that
 *     page's own artwork, which is `openCardMedia` — resolved upstream from
 *     columns 0039 blanks for a gated row. Waiting for a classification there
 *     protected nothing: the image is one click behind the link being
 *     previewed. A moderator's `adult` or `rejected` still withholds it.
 *   * The title is `safeShareTitle`. An adult-focused creation's real title
 *     and tagline never leave, so what it gets is the copy its creator wrote
 *     FOR the outside, or "18+ creation by @creator".
 *   * Everything else on the card — the creation type, the handle, the
 *     wordmark, the accent, the creator's profile picture — is either platform
 *     vocabulary or the creator's public identity. None of it is page copy.
 */

/** The outward-facing name for a structure. Short enough to sit in a corner. */
const typeLabels: Record<CreationType, string> = {
  character: "Character",
  cast: "Cast",
  // "Scenario / RPG" is the studio's label, written for somebody choosing what
  // to make. A preview has room for the noun and nothing else.
  scenario: "Scenario",
};

/** How much of a line survives. Satori does not reflow; this is the reflow. */
const titleLimit = 64;
const taglineLimit = 104;

/**
 * Where a 1200×630 window sits over artwork whose creator said nothing.
 *
 * The upper third, because the subject of a portrait upload almost always is
 * there and a centred crop of a 3:4 character sheet is a torso. It is a guess,
 * which is exactly why it must not survive contact with a creator who has
 * already pointed at their subject — see `artworkPosition` below.
 */
export const defaultArtworkPosition = "50% 32%";

function clip(value: string, limit: number) {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The artwork this card may composite, as a URL the renderer can fetch.
 *
 * Empty for anything the caller resolved to a fallback — which is every mode's
 * refusal, whichever rule produced it.
 *
 * The scheme check is the second rule and belongs to this side of the line: a
 * nominated external URL is creator-supplied text, and rendering it means THIS
 * SERVER makes the request. `https:` and inline image data are the two forms
 * that can be an image on somebody else's machine; anything else — an internal
 * hostname, a `file:` path, a scheme with a surprise in it — is not drawn.
 */
export function ogCardArtwork(share: PublicSafeLanding["share"], bucket = characterAvatarBucket) {
  if (share.kind === "storage") return avatarSource(bucket, share.path, "");
  if (share.kind === "external") {
    const url = share.url.trim();
    return /^https:\/\//i.test(url) || /^data:image\//i.test(url) ? url : "";
  }
  return "";
}

export type OgCardModel = {
  /** The name this creation may be called outside Afterglow. Never empty. */
  title: string;
  /** The creator's handle with its "@", or empty when they have none. */
  handle: string;
  /** Character, Cast or Scenario. */
  type: string;
  /** The creator's outward-facing line, or empty. Never the page's tagline. */
  tagline: string;
  /** Composited artwork, or empty for the branded fallback composition. */
  artwork: string;
  /**
   * Where the 1200×630 window sits over that artwork, as `object-position`.
   *
   * The creator's own focal point where they set one, and
   * `defaultArtworkPosition` where they did not. Never a constant when they
   * have already said where the subject is: a creation framed in the studio
   * and then re-cropped down the middle by the share card is the framing
   * feature failing on the one surface strangers see.
   */
  artworkPosition: string;
  /** The creation's accent, validated as a colour. */
  accent: string;
  /** Whether the card carries the understated 18+ marker. */
  adult: boolean;
  /**
   * The creator's public profile picture, or empty when they have none.
   *
   * Present in every mode. It identifies the person who made the creation, not
   * the creation, and their profile page is public in all three modes — so a
   * gated card carries it exactly as an open one does. Empty means the card
   * simply has no avatar; there is deliberately nothing drawn in its place.
   */
  creatorAvatar: string;
};

/**
 * The card for one creation.
 *
 * Every field is derived from the safe landing model, which is the only shape
 * an anonymous reader's data may come from — see src/lib/public-view.ts. A
 * gated creation's row arrives with its name and title already blanked by SQL,
 * and with `openArt` blanked the same way, so even a mistake here has nothing
 * explicit to reach for.
 */
export function ogCardModel(
  landing: PublicSafeLanding,
  bucket = characterAvatarBucket,
  creatorBucket = profileAvatarBucket,
): OgCardModel {
  const open = readableWithoutAccount(landing.contentMode);
  const title = clip(safeShareTitle({
    contentMode: landing.contentMode,
    shareTitle: landing.shareTitle,
    title: landing.title,
    name: landing.name,
    creatorUsername: landing.creator.username,
  }), titleLimit);
  const handle = landing.creator.username.trim();
  /*
   * Two doors, and which one this creation gets is decided by its mode alone.
   *
   * `share` is the classified door and is the ONLY one an adult-focused
   * creation has. `openArt` is the already-public door, and its own resolution
   * has refused a gated mode before this line runs — so the choice below is
   * stated twice, in two modules, and both would have to be wrong together.
   */
  const media = open ? landing.openArt.media : landing.share;
  const artwork = ogCardArtwork(media, bucket);
  return {
    title,
    handle: handle ? `@${handle}` : "",
    type: typeLabels[landing.creationType],
    // The share tagline is written for the outside in every mode, which is
    // precisely why it is the only line that may appear on a gated creation's
    // card. The page's own tagline is not in this model to be reached for.
    tagline: clip(landing.shareTagline, taglineLimit),
    artwork,
    // Framing applies to the creation's PRIMARY artwork and to nothing else: a
    // separately nominated share image is a different picture, and a focal
    // point chosen for the cover would crop it somewhere arbitrary.
    artworkPosition: (artwork && open && landing.openArt.isCover
      ? objectPosition(landing.openArt.presentation, "cover", "16:9")
      : null) ?? defaultArtworkPosition,
    accent: normalizeAccent(landing.accent),
    adult: !open,
    creatorAvatar: avatarSource(creatorBucket, landing.creator.avatarPath.trim(), ""),
  };
}

/**
 * Where a creation's preview image lives.
 *
 * Always this route, never the artwork itself. Handing a crawler the raw file
 * would publish a creator's image with no Afterglow on it, no title, and no
 * way to tell two creations apart — and it would make the preview a copy of an
 * asset rather than a rendering of a decision, so a later classification
 * change could not take it back.
 */
export function ogCardUrl(creationId: string) {
  return absoluteUrl(`/api/og/card?id=${encodeURIComponent(creationId)}`);
}
