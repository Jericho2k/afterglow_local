import { normalizeAccent, readableAccent } from "@/lib/accent";
import { ogCardElement, ogCardHeight, ogCardWidth } from "@/lib/og-card-render";
import { ogCardModel, type OgCardModel } from "@/lib/og-card";
import { publicSafeLanding } from "@/lib/public-view";

/**
 * The image a link preview of a creation actually shows.
 *
 * This route used to draw the wordmark on a gradient and nothing else, for
 * every creation in the catalogue. It was safe and it was useless: two
 * completely different creations produced the same picture, and the only thing
 * a preview said about a shared link was that Afterglow exists. The other half
 * was worse in a quieter way — a creation WITH approved artwork handed the
 * crawler the raw file, so the best previews in the product carried no title,
 * no creator and no Afterglow at all.
 *
 * So the card is composed here, always, and the artwork is a layer inside it
 * rather than the answer to it. What varies is decided by
 * `src/lib/og-card.ts`; this file is the drawing.
 *
 * WHAT MAY BE DRAWN is not this file's decision either, and that matters more
 * than how it looks:
 *
 *   * The creation is resolved from its id through `publicSafeLanding`, which
 *     is the anonymous view model — a private, unlisted or removed creation
 *     resolves to nothing and gets the plain branded card.
 *   * No text is ever taken from the query string. The route reads an id and a
 *     colour, and everything printed on the card comes from the database row
 *     that id resolves to. That property is why this route cannot be turned
 *     into a renderer for somebody else's words, and it survives the redesign.
 *   * Artwork appears only where `share_media_status = 'safe'`; `shareMedia`
 *     decides that once, upstream, and an unreviewed creation reaches the
 *     composition with no image in its model.
 */

const width = ogCardWidth;
const height = ogCardHeight;

const ink = "#f6eef4";
const muted = "#c9b6c6";
const ground = "#0b0710";

function accentFrom(request: Request) {
  const requested = new URL(request.url).searchParams.get("accent") || "";
  return /^#[0-9a-fA-F]{3,8}$/.test(requested) ? requested : "#e879a9";
}

/** Only a well-formed id is worth a database round trip. */
function creationIdFrom(request: Request) {
  const requested = new URL(request.url).searchParams.get("id") || "";
  return /^[0-9a-f-]{36}$/i.test(requested) ? requested : "";
}

function escapeXml(value: string) {
  return value.replace(/[<>&"']/g, (character) => (
    { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[character] ?? character
  ));
}

/**
 * The SVG the runtime falls back to.
 *
 * `next/og` renders through WebAssembly and a standalone Docker build does not
 * always carry those binaries into the runtime image. A served SVG degrades to
 * "no preview image" in the clients that will not render it, which is a far
 * better failure than a 500 inside somebody else's chat client — so the PNG is
 * attempted and this is the answer if anything about it throws.
 *
 * It carries the same words as the composition, minus the photograph: an SVG
 * that referenced a remote image would be a second fetch these clients are
 * least likely to make.
 */
function brandedSvg(card: OgCardModel | null, rawAccent: string) {
  const accent = normalizeAccent(rawAccent);
  const tint = readableAccent(accent);
  const label = card ? escapeXml([card.type, card.handle].filter(Boolean).join(" · ")) : "CHARACTERS WITH MEMORY";
  const title = card ? escapeXml(card.title) : "Afterglow";
  const tagline = card ? escapeXml(card.tagline) : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="glow" cx="18%" cy="88%" r="78%">
      <stop offset="0%" stop-color="${escapeXml(accent)}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${escapeXml(accent)}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="${ground}"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <rect x="0" y="0" width="10" height="${height}" fill="${escapeXml(accent)}" opacity="0.85"/>
  <text x="72" y="110" font-family="Georgia, 'Times New Roman', serif" font-size="34" fill="${ink}" letter-spacing="4">Afterglow</text>
  ${card?.adult ? `<text x="${width - 72}" y="110" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="${muted}" letter-spacing="3">18+</text>` : ""}
  <text x="72" y="${tagline ? 400 : 430}" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="${escapeXml(tint)}" letter-spacing="5">${label.toUpperCase()}</text>
  <text x="72" y="${tagline ? 476 : 506}" font-family="Georgia, 'Times New Roman', serif" font-size="${title.length > 34 ? 58 : 72}" fill="${ink}">${title}</text>
  ${tagline ? `<text x="72" y="540" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="${muted}">${tagline}</text>` : ""}
</svg>`;
}

export async function GET(request: Request) {
  const id = creationIdFrom(request);
  /*
   * A preview must never fail loudly. Every step below is allowed to produce
   * nothing — an unknown id, a database that is unreachable, a row that is not
   * public — and "nothing" is the plain branded card rather than an error.
   */
  const landing = id ? await publicSafeLanding(id).catch(() => null) : null;
  const card = landing ? ogCardModel(landing) : null;
  const accent = card?.accent ?? accentFrom(request);
  /*
   * Short, because the card now says something that can change.
   *
   * A title edit, a re-nomination, or a moderator withdrawing an approval all
   * change what this route may draw, and the old header promised a day of
   * immutability. An hour at the edge keeps a withdrawal effective without
   * making every crawl a render.
   */
  const cache = card
    ? "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400"
    : "public, max-age=3600, s-maxage=86400";

  try {
    const { ImageResponse } = await import("next/og");
    return new ImageResponse(
      ogCardElement(card ?? {
        // The product's own card, for a link that names no creation — a world,
        // a creator profile, or an id that resolved to nothing.
        title: "Afterglow", handle: "", type: "Characters with memory", tagline: "",
        artwork: "", accent, adult: false, monogram: "",
      }),
      { width, height, headers: { "Cache-Control": cache } },
    );
  } catch {
    return new Response(brandedSvg(card, accent), {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": cache },
    });
  }
}
