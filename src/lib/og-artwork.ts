/**
 * Getting a creation's artwork as far as the raster, or saying why it did not.
 *
 * The card composition was correct and the model was correct and public
 * creations still shared artless cards. The reason turned out to be one line
 * further down than anybody was looking: the renderer behind `next/og` draws
 * PNG and JPEG, and `uploadImage` accepts PNG, JPEG, WebP and GIF — so a
 * creator whose cover was a WebP got a card with no picture on it, and NOTHING
 * anywhere said so. Satori does not throw on an image it cannot use; it omits
 * it and renders the rest of the composition perfectly. The output is a
 * beautiful card that is missing the one thing it was redesigned to show, and
 * it is indistinguishable from a creation that has no artwork at all.
 *
 * (A `data:` WebP is worse and differently wrong: that one throws, from inside
 * the response stream, after `new ImageResponse(...)` has already returned — so
 * the route's own try/catch cannot see it either. tests/og-artwork.test.ts
 * pins both behaviours against the bundled renderer, so an upgrade that fixes
 * or changes them is a failing test rather than a surprise.)
 *
 * This module is the place that refuses to be silent. Every way artwork can
 * fail to reach the card is a named outcome, the route turns that outcome into
 * a response header, and the moderator diagnostic reports it for a given
 * creation. "The card has no picture" is now always accompanied by a reason.
 *
 * It also means the sniff is authoritative rather than advisory: bytes that
 * pass are handed to the renderer AS bytes, so there is no second fetch that
 * could resolve to something else, and nothing the renderer might choke on can
 * reach it.
 */

/** What the bundled renderer will actually draw. Verified, not assumed. */
export const renderableImageTypes = ["image/png", "image/jpeg"] as const;
export type RenderableImageType = (typeof renderableImageTypes)[number];

/**
 * Big enough for any upload, small enough to be a bound.
 *
 * `uploadImage` caps a file at 5 MB and the storage buckets cap it again, so
 * this only ever bites on a creator-supplied external URL — which is somebody
 * else's server and should not be able to decide how much memory this route
 * uses.
 */
export const maxArtworkBytes = 6_000_000;

/** How long a preview will wait for somebody else's image server. */
export const artworkFetchTimeoutMs = 4_000;

/**
 * The format, read from the bytes rather than from a header or an extension.
 *
 * A `Content-Type` is whatever the server felt like sending and a path suffix
 * is whatever the uploader felt like naming the file; the magic bytes are what
 * the renderer will actually be handed. Returns "" for anything unrecognised,
 * which is treated exactly like a format known to be unsupported.
 */
export function sniffImageType(bytes: Uint8Array): string {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  const ascii = (offset: number, text: string) =>
    [...text].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  if (ascii(0, "<svg") || ascii(0, "<?xml")) return "image/svg+xml";
  return "";
}

export function isRenderableImageType(type: string): type is RenderableImageType {
  return (renderableImageTypes as readonly string[]).includes(type);
}

const suffixTypes: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", avif: "image/avif", svg: "image/svg+xml",
};

/**
 * The format a stored object CLAIMS, from its suffix.
 *
 * A guess anywhere else and a fact here: `avatarObjectPath` writes the suffix
 * from the uploaded file's own type, so an object in our storage is named for
 * what it is. That makes it good enough to warn a creator in the studio —
 * before they publish and go looking at a card — without fetching the picture
 * to a browser that already has it on screen.
 *
 * Empty for anything with no recognisable suffix, which callers must read as
 * "unknown", never as "unsupported": an imported card's external URL routinely
 * ends in a query string or nothing at all.
 */
export function declaredImageType(pathOrUrl: string) {
  const withoutQuery = (pathOrUrl || "").split(/[?#]/)[0];
  const suffix = /\.([a-z0-9]+)$/i.exec(withoutQuery)?.[1]?.toLowerCase() ?? "";
  return suffixTypes[suffix] ?? "";
}

/**
 * Whether a stored image is one the card renderer is known NOT to draw.
 *
 * Deliberately asymmetric. It answers true only when the suffix names a format
 * that has been verified unsupported, so an unknown suffix stays silent rather
 * than warning a creator about a picture that will be fine.
 */
export function knownUnrenderable(pathOrUrl: string) {
  const type = declaredImageType(pathOrUrl);
  return Boolean(type) && !isRenderableImageType(type);
}

/**
 * Where a card's artwork got to.
 *
 * One state per way it can end, because the whole point is that "no picture"
 * stops being one undifferentiated outcome. `ready` is the only one that draws;
 * every other state is a branded card WITH A REASON.
 */
export type CardArtwork =
  /** The model had no artwork to draw — gated, unnominated, or no upload. */
  | { state: "absent" }
  /** Not `https:` or inline image data. See `ogCardArtwork`. */
  | { state: "blocked_scheme" }
  /** The image server answered with something other than a 2xx. */
  | { state: "unreachable"; status: number }
  /** It did not answer in time, or the request failed outright. */
  | { state: "no_response" }
  /** Larger than this route is willing to hold in memory. */
  | { state: "oversized"; bytes: number }
  /** A real image the bundled renderer cannot draw — WebP and GIF, today. */
  | { state: "unsupported_format"; format: string; bytes: number }
  | { state: "ready"; format: RenderableImageType; bytes: number; source: string };

/** Everything about an outcome except the picture itself. Safe to log or return. */
export function artworkReport(artwork: CardArtwork) {
  return {
    state: artwork.state,
    format: "format" in artwork ? artwork.format : "",
    bytes: "bytes" in artwork ? artwork.bytes : 0,
    status: "status" in artwork ? artwork.status : 0,
    /** Whether a card built from this outcome will carry a picture. */
    drawn: artwork.state === "ready",
  };
}

/**
 * Fetches artwork and decides whether the renderer may have it.
 *
 * `fetcher` is injectable so the tests can drive every branch without a
 * network, and so a future runtime with its own fetch semantics has one place
 * to change. The bytes come back as a `data:` URI rather than as a URL, which
 * is what makes the check binding: the renderer is handed exactly what was
 * inspected, and cannot re-fetch its way into something else.
 */
export async function loadCardArtwork(
  url: string,
  fetcher: typeof fetch = fetch,
): Promise<CardArtwork> {
  const source = url.trim();
  if (!source) return { state: "absent" };
  if (!/^https:\/\//i.test(source) && !/^data:image\//i.test(source)) return { state: "blocked_scheme" };

  let bytes: Uint8Array;
  if (/^data:image\//i.test(source)) {
    // Already inline: no request to make, and the same rules still apply.
    const comma = source.indexOf(",");
    const payload = comma < 0 ? "" : source.slice(comma + 1);
    const base64 = /;base64/i.test(source.slice(0, comma < 0 ? source.length : comma));
    try {
      bytes = base64
        ? Uint8Array.from(Buffer.from(payload, "base64"))
        : new TextEncoder().encode(decodeURIComponent(payload));
    } catch { return { state: "no_response" }; }
  } else {
    let response: Response;
    try {
      response = await fetcher(source, { signal: AbortSignal.timeout(artworkFetchTimeoutMs) });
    } catch { return { state: "no_response" }; }
    if (!response.ok) return { state: "unreachable", status: response.status };
    /*
     * The declared length is checked BEFORE the body is read, so an oversized
     * image costs nothing rather than being downloaded and then rejected. A
     * server that declares nothing is still bounded below, after the read.
     */
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxArtworkBytes) return { state: "oversized", bytes: declared };
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch { return { state: "no_response" }; }
  }

  if (bytes.byteLength > maxArtworkBytes) return { state: "oversized", bytes: bytes.byteLength };
  const format = sniffImageType(bytes);
  if (!isRenderableImageType(format)) {
    return { state: "unsupported_format", format: format || "unknown", bytes: bytes.byteLength };
  }
  return {
    state: "ready",
    format,
    bytes: bytes.byteLength,
    source: `data:${format};base64,${Buffer.from(bytes).toString("base64")}`,
  };
}
