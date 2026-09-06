import { normalizeAccent } from "./accent";
import { readableWithoutAccount, safeShareTitle } from "./content-mode";
import type { PublicSafeLanding } from "./public-view";
import { absoluteUrl } from "./site";
import { avatarSource, characterAvatarBucket } from "./storage";
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
 *   * Artwork appears only when the platform has classified the nominated
 *     media `safe`. That decision is `shareMedia`, made once, before this is
 *     called, and this module cannot reach past it — it is handed a resolved
 *     `ShareMedia` and an unreviewed one carries no path to draw.
 *   * The title is `safeShareTitle`. An adult-focused creation's real title
 *     and tagline never leave, so what it gets is the copy its creator wrote
 *     FOR the outside, or "18+ creation by @creator".
 *   * Everything else on the card — the creation type, the handle, the
 *     wordmark, the accent — is either platform vocabulary or the creator's
 *     public identity. None of it is page copy.
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

function clip(value: string, limit: number) {
  const text = (value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The artwork this card may composite, as a URL the renderer can fetch.
 *
 * Empty for everything unreviewed, adult, rejected or absent — `shareMedia`
 * has already decided that and returns a fallback, which has no image in it.
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
  /** The creation's accent, validated as a colour. */
  accent: string;
  /** Whether the card carries the understated 18+ marker. */
  adult: boolean;
  /**
   * One or two letters drawn in place of artwork, or empty.
   *
   * Only for a creation whose title is already public. A gated creation's
   * initial would be an initial of "18+ creation by …", which says nothing,
   * and deriving one from the real title is exactly what must never happen.
   */
  monogram: string;
};

/*
 * One letter, not initials.
 *
 * "Seraphine of the Long Quay" has no good two-letter form — "SO" is worse
 * than nothing — and a title in a script with no case, or one that opens with
 * punctuation, has none at all. A single opening letter is the only rule that
 * is right for every title, and the composition draws it large enough that one
 * letter is a graphic rather than an abbreviation.
 */
function monogramFor(title: string) {
  const first = title.trim()[0] ?? "";
  return /^[\p{L}\p{N}]$/u.test(first) ? first.toUpperCase() : "";
}

/**
 * The card for one creation.
 *
 * Every field is derived from the safe landing model, which is the only shape
 * an anonymous reader's data may come from — see src/lib/public-view.ts. A
 * gated creation's row arrives with its name and title already blanked by SQL,
 * so even a mistake here has nothing explicit to reach for.
 */
export function ogCardModel(landing: PublicSafeLanding, bucket = characterAvatarBucket): OgCardModel {
  const open = readableWithoutAccount(landing.contentMode);
  const title = clip(safeShareTitle({
    contentMode: landing.contentMode,
    shareTitle: landing.shareTitle,
    title: landing.title,
    name: landing.name,
    creatorUsername: landing.creator.username,
  }), titleLimit);
  const handle = landing.creator.username.trim();
  return {
    title,
    handle: handle ? `@${handle}` : "",
    type: typeLabels[landing.creationType],
    // The share tagline is written for the outside in every mode, which is
    // precisely why it is the only line that may appear on a gated creation's
    // card. The page's own tagline is not in this model to be reached for.
    tagline: clip(landing.shareTagline, taglineLimit),
    artwork: ogCardArtwork(landing.share, bucket),
    accent: normalizeAccent(landing.accent),
    adult: !open,
    monogram: open ? monogramFor(title) : "",
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
