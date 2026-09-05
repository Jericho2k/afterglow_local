/**
 * How a creation's artwork is framed, everywhere it appears.
 *
 * One upload is shown at four different shapes — a 3:4 discovery card, a small
 * near-square ranked row, a full-bleed phone hero, a wide desktop band — and
 * until now each shape cropped it at a constant chosen in a stylesheet for no
 * particular image. That works for artwork whose subject sits where the
 * constant points and fails for everything else, and the creator's only
 * recourse was to re-crop the file offline until it looked acceptable in the
 * one place they happened to be looking.
 *
 * A focal point fixes that without touching the image: it names the part of
 * the picture that must survive every crop, and each surface positions its own
 * window around it. The original asset is never modified, and there is no
 * second, cropped copy to keep in step with it.
 *
 * The rule this module exists to enforce is that ABSENT MEANS UNCHANGED. A
 * creation whose creator has never opened the picker has no presentation
 * document, and every surface then falls back to the exact `object-position`
 * its stylesheet has always used. Nothing in the catalogue moves because this
 * shipped.
 */

/** A point in the image, 0–1 on each axis, left/top origin. */
export type FocalPoint = { x: number; y: number };

export type ArtPresentation = {
  /** Framing for the primary artwork. */
  cover?: { focal?: FocalPoint };
  /** Framing for the optional desktop banner. */
  banner?: { focal?: FocalPoint };
  /**
   * Per-aspect overrides, keyed by ratio ("3:4", "16:9").
   *
   * Read here and written by nothing yet. The slot exists so that the day a
   * creator wants a different focus on the card than in the hero, it is a
   * document this code already understands rather than another migration.
   */
  aspects?: Record<string, { focal?: FocalPoint }>;
};

/** The document version this module writes. Stored so a reader can tell. */
export const artPresentationVersion = 1;

function focal(value: unknown): FocalPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const point = value as Record<string, unknown>;
  const x = Number(point.x);
  const y = Number(point.y);
  // NaN fails every comparison, so this rejects a missing or non-numeric
  // coordinate without testing for it separately.
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return undefined;
  return { x, y };
}

/**
 * A stored document, made safe to read.
 *
 * Anything malformed resolves to "no metadata" rather than to a default focal
 * point, because those are different claims: the first says the stylesheet
 * decides, the second says a creator chose the middle. A row written by a
 * future release, or by hand, must not be able to move a crop by being
 * unparseable.
 */
export function artPresentation(value: unknown): ArtPresentation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const stored = value as Record<string, unknown>;
  const result: ArtPresentation = {};
  const coverFocal = focal((stored.cover as Record<string, unknown> | undefined)?.focal);
  if (coverFocal) result.cover = { focal: coverFocal };
  const bannerFocal = focal((stored.banner as Record<string, unknown> | undefined)?.focal);
  if (bannerFocal) result.banner = { focal: bannerFocal };
  if (stored.aspects && typeof stored.aspects === "object" && !Array.isArray(stored.aspects)) {
    const aspects: Record<string, { focal?: FocalPoint }> = {};
    for (const [ratio, entry] of Object.entries(stored.aspects as Record<string, unknown>)) {
      const point = focal((entry as Record<string, unknown> | undefined)?.focal);
      if (point) aspects[ratio] = { focal: point };
    }
    if (Object.keys(aspects).length) result.aspects = aspects;
  }
  return result;
}

/** The document to store, or `{}` when a creator has chosen nothing. */
export function artPresentationDocument(presentation: ArtPresentation) {
  const document: Record<string, unknown> = {};
  if (presentation.cover?.focal) document.cover = { focal: presentation.cover.focal };
  if (presentation.banner?.focal) document.banner = { focal: presentation.banner.focal };
  if (presentation.aspects && Object.keys(presentation.aspects).length) document.aspects = presentation.aspects;
  // A document with nothing in it is stored as nothing, so "the creator has
  // not chosen" and "the creator chose the defaults" stay distinguishable.
  return Object.keys(document).length ? { v: artPresentationVersion, ...document } : {};
}

/**
 * The `object-position` for a surface, or null to leave the stylesheet alone.
 *
 * Null is the important return. Emitting `50% 25%` for an unset creation would
 * be correct on the cards and wrong on the hero, which uses a different
 * constant — and it would freeze today's constants into inline styles where a
 * future design change could no longer reach them. So an unset creation gets
 * no inline style at all and CSS keeps deciding.
 *
 * `aspect` selects a per-ratio override when one exists, which is why every
 * caller passes the shape it is drawing even though nothing writes overrides
 * yet: the call sites are then already correct when something does.
 */
export function objectPosition(presentation: ArtPresentation, target: "cover" | "banner" = "cover", aspect?: string) {
  const override = aspect ? presentation.aspects?.[aspect]?.focal : undefined;
  const point = override ?? presentation[target]?.focal;
  if (!point) return null;
  return `${round(point.x * 100)}% ${round(point.y * 100)}%`;
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

/**
 * The style object a surface spreads onto its image.
 *
 * Returns an empty object rather than `undefined` so a caller can spread it
 * unconditionally: `style={{ ...artStyle(...) }}` reads the same whether or not
 * the creation has metadata, and there is no branch to get wrong.
 */
export function artStyle(presentation: ArtPresentation, target: "cover" | "banner" = "cover", aspect?: string) {
  const position = objectPosition(presentation, target, aspect);
  return position ? { objectPosition: position } : {};
}

export type CreationArt = {
  avatarPath: string;
  avatarUrl: string;
  bannerPath: string;
  bannerUrl: string;
  presentation: ArtPresentation;
};

/**
 * Which image a wide surface should draw, and how to frame it.
 *
 * The fallback is the whole point: a creation with no banner is not a creation
 * with no hero. It uses its primary artwork with the cover focal point, which
 * is exactly what it does today — so adding banner support costs nothing to
 * every creation that will never have one.
 */
export function bannerArt(art: CreationArt) {
  const path = (art.bannerPath || "").trim();
  const url = (art.bannerUrl || "").trim();
  if (path || url) {
    return { path, url, style: artStyle(art.presentation, "banner", "16:9"), dedicated: true };
  }
  return {
    path: (art.avatarPath || "").trim(),
    url: (art.avatarUrl || "").trim(),
    style: artStyle(art.presentation, "cover", "16:9"),
    dedicated: false,
  };
}
