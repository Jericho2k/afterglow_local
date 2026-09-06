import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  artworkReport, declaredImageType, isRenderableImageType, knownUnrenderable,
  loadCardArtwork, maxArtworkBytes, renderableImageTypes, sniffImageType,
} from "@/lib/og-artwork";
import { needsRenderableConversion, renderableFileName } from "@/lib/uploads";
import { ogCardElement, ogCardHeight, ogCardWidth } from "@/lib/og-card-render";
import { defaultArtworkPosition } from "@/lib/og-card";

/**
 * The step nobody was looking at, pinned.
 *
 * A public creation with artwork produced a card with no picture on it. Every
 * layer above this one was correct — the row, the SQL, the view model, the card
 * model all carried the cover — and the reason was that the renderer behind
 * `next/og` silently declines to draw the formats `uploadImage` happily
 * accepted. It does not throw and it does not warn: it omits the image and
 * renders the rest of the composition perfectly, so the output is
 * indistinguishable from a creation that has no artwork at all.
 *
 * The first block below is the load-bearing one. It is not a test of our code —
 * it is a test of the BUNDLED RENDERER, asserted by rendering the same
 * composition twice and comparing the bytes, because that is the only way to
 * tell "drew the picture" from "quietly skipped it". If a Next upgrade changes
 * what Satori can draw, this fails and the lists move deliberately.
 */

// 1x1 solid red, one per format the studio's file picker accepts. Stretched to
// fill the frame, so drawn and not-drawn are visibly different pictures.
const red: Record<string, Buffer> = {
  png: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"),
  jpeg: Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64"),
  gif: Buffer.from("R0lGODlhAQABAIABAP8AAAAAACH5BAEAAAEALAAAAAABAAEAAAICTAEAOw==", "base64"),
  webp: Buffer.from("UklGRjoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAABBxAREYiI/gcAAABWUDggGAAAADABAJ0BKgEAAQADADQlpAADcAD++5QAAA==", "base64"),
};
const contentTypes: Record<string, string> = {
  png: "image/png", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};

let server: Server;
let origin = "";

/**
 * An https URL served by the local http fixture.
 *
 * The loader refuses anything but `https:` and inline data, which is a rule
 * worth keeping under test rather than working around — so the URL is real and
 * the transport is redirected through the injectable fetcher instead.
 */
const remote = (route: string) => `https://storage.test/${route}`;
const viaFixture: typeof fetch = (input, init) =>
  fetch(String(input).replace("https://storage.test", origin), init);
beforeAll(async () => {
  server = createServer((request, response) => {
    const route = (request.url ?? "").replace("/", "");
    if (route === "missing") { response.writeHead(404); response.end("no"); return; }
    if (route === "html") { response.writeHead(200, { "Content-Type": "text/html" }); response.end("<html>nope</html>"); return; }
    if (route === "huge") {
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": String(maxArtworkBytes + 1) });
      response.end(red.png);
      return;
    }
    const bytes = red[route];
    if (!bytes) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "Content-Type": contentTypes[route] });
    response.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(() => { server.close(); });

/*
 * A neutral frame, deliberately NOT the card composition.
 *
 * The card changes its scrim, its text colour and its column width depending on
 * whether artwork is present, so comparing two of those would compare the
 * layout rather than the picture. This isolates the one question: given an
 * image, does the renderer put any of it on the canvas?
 */
async function raster(artwork: string) {
  const { ImageResponse } = await import("next/og");
  const response = new ImageResponse(
    <div style={{ display: "flex", width: 200, height: 100, background: "#111111", position: "relative" }}>
      {artwork
        ? <img src={artwork} alt="" width={200} height={100} style={{ position: "absolute", top: 0, left: 0, width: 200, height: 100, objectFit: "cover" }} />
        : null}
    </div>,
    { width: 200, height: 100 },
  );
  return Buffer.from(await response.arrayBuffer());
}

/** The real composition, to prove the route's own card still rasters. */
async function rasterCard(artwork: string) {
  const { ImageResponse } = await import("next/og");
  const response = new ImageResponse(
    ogCardElement({
      title: "Seraphine", handle: "@alice", type: "Character", tagline: "",
      artwork, artworkPosition: defaultArtworkPosition, accent: "#e879a9", adult: false, creatorAvatar: "",
    }),
    { width: ogCardWidth, height: ogCardHeight },
  );
  return Buffer.from(await response.arrayBuffer());
}

describe("what the bundled renderer will actually draw", () => {
  it("draws PNG and JPEG and silently skips WebP and GIF", async () => {
    /*
     * The bug, reproduced at the layer it lives in. `artless` is the card with
     * no artwork at all; a format the renderer cannot use produces EXACTLY
     * those bytes, which is the whole reason this was invisible from the
     * outside.
     */
    const artless = await raster("");
    const drew = async (format: string) => !(await raster(`data:${contentTypes[format]};base64,${red[format].toString("base64")}`)).equals(artless);

    expect(await drew("png"), "PNG").toBe(true);
    expect(await drew("jpeg"), "JPEG").toBe(true);
    expect(await drew("gif"), "GIF is not drawn").toBe(false);
    // And the composition itself still rasters either way, which is why the
    // failure was invisible: a card with a skipped image is a perfectly good
    // PNG of a card with no image.
    expect([...(await rasterCard("")).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // WebP is worse than skipped: as inline data it throws, from inside the
    // response stream, after `new ImageResponse(...)` has already returned — so
    // a try/catch around the constructor never sees it. This is why the route
    // must never hand the renderer bytes it has not identified.
    await expect(raster(`data:image/webp;base64,${red.webp.toString("base64")}`)).rejects.toThrow();
  }, 60_000);

  it("keeps the renderable list honest about that", () => {
    expect([...renderableImageTypes]).toEqual(["image/png", "image/jpeg"]);
    // The studio's picker still accepts all four; the gap between the two lists
    // is what `uploadImage`'s conversion closes.
    for (const format of ["image/webp", "image/gif"]) {
      expect(isRenderableImageType(format), format).toBe(false);
      expect(needsRenderableConversion(format), format).toBe(true);
    }
    expect(needsRenderableConversion("image/png")).toBe(false);
    expect(needsRenderableConversion("image/jpeg")).toBe(false);
  });

  it("never fetches a remote image itself, so an unidentified one cannot reach it", async () => {
    // The route resolves bytes and hands them over inline. If it ever went back
    // to passing a URL, the renderer would fetch it and go quiet again.
    const route = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/app/api/og/card/route.tsx", import.meta.url), "utf8"));
    expect(route).toContain("loadCardArtwork(card?.artwork ?? \"\")");
    expect(route).toContain("artwork.state === \"ready\" ? artwork.source : \"\"");
  });
});

describe("the format is read from the bytes", () => {
  it("recognises each format a creator can upload", () => {
    expect(sniffImageType(red.png)).toBe("image/png");
    expect(sniffImageType(red.jpeg)).toBe("image/jpeg");
    expect(sniffImageType(red.gif)).toBe("image/gif");
    expect(sniffImageType(red.webp)).toBe("image/webp");
  });

  it("does not believe a suffix, a header, or anything else", () => {
    // A WebP named .png is still a WebP to the renderer, so it must still be
    // one here. The magic bytes are what will actually be handed over.
    expect(sniffImageType(new Uint8Array(Buffer.from("<html>", "utf8")))).toBe("");
    expect(sniffImageType(new Uint8Array())).toBe("");
  });
});

describe("every way artwork fails is a named outcome", () => {
  it("draws a real PNG and a real JPEG", async () => {
    for (const format of ["png", "jpeg"] as const) {
      const outcome = await loadCardArtwork(remote(format), viaFixture);
      expect(outcome.state, format).toBe("ready");
      expect(artworkReport(outcome)).toMatchObject({ state: "ready", format: contentTypes[format], drawn: true });
      if (outcome.state === "ready") expect(outcome.source.startsWith(`data:${contentTypes[format]};base64,`)).toBe(true);
    }
  });

  it("distinguishes an unsupported format from an empty model", async () => {
    // The distinction the previous release could not make, and the reason a
    // whole catalogue of WebP covers looked like a catalogue of creations with
    // no artwork.
    expect(artworkReport(await loadCardArtwork(""))).toMatchObject({ state: "absent", drawn: false });
    const webp = await loadCardArtwork(remote("webp"), viaFixture);
    expect(artworkReport(webp)).toMatchObject({ state: "unsupported_format", format: "image/webp", drawn: false });
    const gif = await loadCardArtwork(remote("gif"), viaFixture);
    expect(artworkReport(gif)).toMatchObject({ state: "unsupported_format", format: "image/gif", drawn: false });
  });

  it("distinguishes an image that is not there from one that is not an image", async () => {
    expect(artworkReport(await loadCardArtwork(remote("missing"), viaFixture))).toMatchObject({ state: "unreachable", status: 404 });
    expect(artworkReport(await loadCardArtwork(remote("html"), viaFixture))).toMatchObject({ state: "unsupported_format", format: "unknown" });
  });

  it("refuses a scheme this server should not be made to request", async () => {
    for (const url of ["http://10.0.0.1/internal.png", "file:///etc/passwd", " javascript:alert(1)"]) {
      expect(artworkReport(await loadCardArtwork(url)), url).toMatchObject({ state: "blocked_scheme" });
    }
  });

  it("refuses to hold somebody else's server's idea of a large file", async () => {
    expect(artworkReport(await loadCardArtwork(remote("huge"), viaFixture))).toMatchObject({ state: "oversized" });
  });

  it("reports a request that never answers rather than hanging a preview", async () => {
    const outcome = await loadCardArtwork("https://example.test/art.png", async () => { throw new Error("timed out"); });
    expect(artworkReport(outcome)).toMatchObject({ state: "no_response", drawn: false });
  });

  it("carries no image bytes into a report", () => {
    // The diagnostic endpoint returns this shape, and a picture is not a
    // diagnostic. A byte count and a media type are enough to tell a WebP from
    // a 404.
    const report = artworkReport({ state: "ready", format: "image/png", bytes: 12, source: "data:image/png;base64,AAAA" });
    expect(Object.keys(report).sort()).toEqual(["bytes", "drawn", "format", "state", "status"]);
    expect(JSON.stringify(report)).not.toContain("base64");
  });
});

describe("a creator is told before they publish", () => {
  it("names a stored format the card cannot draw", () => {
    expect(knownUnrenderable("users/a/avatars/cover.webp")).toBe(true);
    expect(knownUnrenderable("users/a/avatars/cover.gif")).toBe(true);
    expect(declaredImageType("users/a/avatars/cover.webp")).toBe("image/webp");
  });

  it("stays silent about anything it cannot actually identify", () => {
    // An imported card's external URL routinely ends in a query string or in
    // nothing at all. Warning about those would be noise about pictures that
    // are very likely fine.
    expect(knownUnrenderable("users/a/avatars/cover.png")).toBe(false);
    expect(knownUnrenderable("https://cdn.example.test/art")).toBe(false);
    expect(knownUnrenderable("")).toBe(false);
    expect(declaredImageType("https://cdn.example.test/art.jpg?v=2")).toBe("image/jpeg");
  });

  it("gives a converted upload a name that matches what it now is", () => {
    expect(renderableFileName("portrait.webp", "image/png")).toBe("portrait.png");
    expect(renderableFileName("portrait.gif", "image/jpeg")).toBe("portrait.jpeg");
    expect(renderableFileName("", "image/png")).toBe("artwork.png");
  });
});
