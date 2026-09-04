/**
 * The branded card a link preview falls back to.
 *
 * Reached whenever a creation has nominated no share-safe image — which is the
 * default for everything adult, and stays the default until a creator chooses
 * otherwise. Its job is to make that case look deliberate: a shared link with
 * no image at all reads as a broken page, and "this creation has not published
 * a preview image" should not look like "this product is broken".
 *
 * It carries NO text from the creation. The accent colour is the only thing
 * that varies, and it is validated as a hex literal before it is used, so this
 * route cannot be turned into a renderer for somebody else's words — which is
 * exactly what it would become if it took a title, given that the creations
 * relying on it most are the adult ones.
 */

const width = 1200;
const height = 630;

function accentFrom(request: Request) {
  const requested = new URL(request.url).searchParams.get("accent") || "";
  return /^#[0-9a-fA-F]{3,8}$/.test(requested) ? requested : "#e879a9";
}

function brandedSvg(accent: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="42%" r="62%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="#0b0710"/>
  <rect width="${width}" height="${height}" fill="url(#glow)"/>
  <text x="50%" y="52%" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="96" fill="#f6eef4" letter-spacing="6">Afterglow</text>
  <text x="50%" y="62%" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="30" fill="#c9b6c6" letter-spacing="3">CHARACTERS WITH MEMORY</text>
</svg>`;
}

export async function GET(request: Request) {
  const accent = accentFrom(request);
  const cache = "public, max-age=3600, s-maxage=86400, immutable";
  /*
   * A raster card where the runtime can make one, an SVG where it cannot.
   *
   * `next/og` renders through WebAssembly, and a standalone Docker build does
   * not always carry those binaries into the runtime image. Rather than making
   * link previews depend on that, the PNG is attempted and the SVG is the
   * answer if anything about it fails: fewer crawlers render SVG, but a served
   * SVG degrades to "no preview image", while an unhandled failure here would
   * be a 500 inside somebody else's chat client.
   */
  try {
    const { ImageResponse } = await import("next/og");
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%", height: "100%", display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", background: "#0b0710",
            backgroundImage: `radial-gradient(circle at 50% 42%, ${accent}8c 0%, #0b071000 62%)`,
          }}
        >
          <div style={{ fontSize: 96, color: "#f6eef4", letterSpacing: 6 }}>Afterglow</div>
          <div style={{ fontSize: 30, color: "#c9b6c6", letterSpacing: 3, marginTop: 12 }}>CHARACTERS WITH MEMORY</div>
        </div>
      ),
      { width, height, headers: { "Cache-Control": cache } },
    );
  } catch {
    return new Response(brandedSvg(accent), {
      headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": cache },
    });
  }
}
