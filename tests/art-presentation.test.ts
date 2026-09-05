import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { artPresentation, artPresentationDocument, artStyle, bannerArt, objectPosition } from "@/lib/art-presentation";
import { creatorLink, creatorLinkRel, creatorLinks } from "@/lib/creator-links";
import { declarationsFor } from "./helpers/css";

const creationCss = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/**
 * Creator-controlled framing.
 *
 * The property that matters most here is the NEGATIVE one: a creation whose
 * creator has never opened the picker must render exactly as it did before this
 * existed. Everything else in the feature is a creator's deliberate choice and
 * they can see the result; the silent regression across a whole catalogue is
 * the one nobody would notice until it was everywhere.
 */

describe("a creation with no framing metadata is untouched", () => {
  it("emits no inline position at all", () => {
    // Not "emits 50% 25%" — emitting anything would freeze today's constants
    // into inline styles where a future design change could not reach them.
    expect(objectPosition(artPresentation(undefined))).toBeNull();
    expect(objectPosition(artPresentation({}))).toBeNull();
    expect(artStyle(artPresentation({}))).toEqual({});
  });

  it("stores nothing when nothing was chosen", () => {
    expect(artPresentationDocument({})).toEqual({});
    // "The creator has not chosen" and "the creator chose the middle" have to
    // stay distinguishable, or the first save of any creation would pin it.
    expect(artPresentationDocument({ cover: {} })).toEqual({});
  });

  it("keeps the hero falling back to the cover, as it always did", () => {
    const art = bannerArt({ avatarPath: "a.png", avatarUrl: "", bannerPath: "", bannerUrl: "", presentation: {} });
    expect(art.path).toBe("a.png");
    expect(art.dedicated).toBe(false);
    expect(art.style).toEqual({});
  });
});

describe("a focal point reaches every surface", () => {
  const presentation = artPresentation({ v: 1, cover: { focal: { x: 0.25, y: 0.1 } } });

  it("becomes an object-position", () => {
    expect(objectPosition(presentation)).toBe("25% 10%");
    expect(artStyle(presentation)).toEqual({ objectPosition: "25% 10%" });
  });

  it("applies at every aspect a surface draws", () => {
    // Portrait card, near-square ranked row, wide hero: one decision, and the
    // same one, because a creation that crops differently per list is a
    // different creation to whoever found it in the other list.
    for (const aspect of ["3:4", "1:1", "16:9"]) {
      expect(artStyle(presentation, "cover", aspect)).toEqual({ objectPosition: "25% 10%" });
    }
  });

  it("lets a per-aspect override win where one exists", () => {
    const overridden = artPresentation({
      v: 1, cover: { focal: { x: 0.5, y: 0.5 } }, aspects: { "3:4": { focal: { x: 0.2, y: 0.05 } } },
    });
    expect(objectPosition(overridden, "cover", "3:4")).toBe("20% 5%");
    expect(objectPosition(overridden, "cover", "16:9")).toBe("50% 50%");
  });

  it("refuses coordinates that are not coordinates", () => {
    // A malformed row resolves to "no metadata" rather than to a default
    // point: those are different claims and only one of them moves a crop.
    expect(objectPosition(artPresentation({ cover: { focal: { x: "left", y: 0.5 } } }))).toBeNull();
    expect(objectPosition(artPresentation({ cover: { focal: { x: 2, y: 0.5 } } }))).toBeNull();
    expect(objectPosition(artPresentation("nonsense"))).toBeNull();
  });
});

describe("the desktop banner", () => {
  const presentation = artPresentation({ v: 1, cover: { focal: { x: 0.3, y: 0.3 } }, banner: { focal: { x: 0.7, y: 0.2 } } });

  it("is used when one exists, with its own framing", () => {
    const art = bannerArt({ avatarPath: "cover.png", avatarUrl: "", bannerPath: "wide.png", bannerUrl: "", presentation });
    expect(art.path).toBe("wide.png");
    expect(art.dedicated).toBe(true);
    expect(art.style).toEqual({ objectPosition: "70% 20%" });
  });

  it("falls back to the cover framed by the COVER's focal point", () => {
    const art = bannerArt({ avatarPath: "cover.png", avatarUrl: "", bannerPath: "", bannerUrl: "", presentation });
    expect(art.path).toBe("cover.png");
    expect(art.style).toEqual({ objectPosition: "30% 30%" });
  });

  it("uses an external URL when there is no stored object", () => {
    const art = bannerArt({ avatarPath: "", avatarUrl: "https://example.com/a.png", bannerPath: "", bannerUrl: "", presentation: {} });
    expect(art.url).toBe("https://example.com/a.png");
  });
});

/**
 * Layout properties the required viewports depend on.
 *
 * Asserted structurally rather than by rendering: `scripts/viewport-overflow-
 * audit.mjs` is what measures these in a real browser at 375, 390, 393 and 430,
 * and these are the rules that measurement relies on, so an edit that breaks
 * one fails here rather than on somebody's phone.
 */
describe("the creation page at the sizes people read it", () => {
  it("keeps the section navigation sticky", () => {
    expect(declarationsFor(creationCss, ".sectionNav").position).toBe("sticky");
    expect(declarationsFor(creationCss, ".sectionNav").top).toBe("0");
  });

  it("does not make the document a scroll container, which would break that", () => {
    /*
     * The actual cause of the reported bug. `overflow-x: hidden` on html/body
     * makes the element a scroll container on BOTH axes, so every sticky
     * descendant stops sticking to the viewport and starts sticking inside the
     * body's scrollport — the navigation was sticky the whole time and had
     * nothing to stick to. `clip` refuses the overflow without creating the
     * container.
     */
    const html = declarationsFor(globalCss, "html");
    expect(html["overflow-x"]).toBe("clip");
    expect(html["overflow-x"]).not.toBe("hidden");
  });

  it("lets Quick Facts wrap and stack instead of squeezing", () => {
    const facts = declarationsFor(creationCss, ".facts");
    // auto-fit with a floor: two facts per row where two genuinely fit, one
    // where they do not, at any width and any length of creator text.
    expect(facts["grid-template-columns"]).toMatch(/auto-fit/);
    expect(facts["grid-template-columns"]).toMatch(/minmax\(min\(100%,\s*\d+px\),\s*1fr\)/);
    const cell = declarationsFor(creationCss, ".facts > div");
    expect(cell["flex-wrap"]).toBe("wrap");
    expect(cell["min-width"]).toBe("0");
  });

  it("never truncates a fact to make it fit", () => {
    // Wrapping is the answer; a clamp would hide what a creator wrote.
    const value = declarationsFor(creationCss, ".facts dd");
    expect(value["overflow-wrap"]).toBe("anywhere");
    expect(value["-webkit-line-clamp"]).toBeUndefined();
  });

  it("shows the accent glow on a phone, not only on a desktop", () => {
    // The base rule spent a release inside the 900px breakpoint, so the
    // surface most of this product is read on had no accent behind its hero.
    const desktopAt = creationCss.indexOf("@media (min-width: 900px)");
    expect(creationCss.indexOf(".heroGlow {")).toBeLessThan(desktopAt);
  });
});

describe("creator links are bounded and safe to render", () => {
  it("keeps http and https", () => {
    expect(creatorLink({ label: "Ko-fi", url: "https://ko-fi.com/someone" })?.url).toBe("https://ko-fi.com/someone");
    expect(creatorLink({ label: "", url: "example.com/me" })?.url).toBe("https://example.com/me");
  });

  it("refuses everything that could execute", () => {
    // The href of an anchor on a page a logged-out stranger can open.
    expect(creatorLink({ label: "x", url: "javascript:alert(1)" })).toBeNull();
    expect(creatorLink({ label: "x", url: "data:text/html;base64,PHNjcmlwdD4=" })).toBeNull();
    expect(creatorLink({ label: "x", url: "vbscript:msgbox(1)" })).toBeNull();
    expect(creatorLink({ label: "x", url: "file:///etc/passwd" })).toBeNull();
  });

  it("labels an unlabelled link with its host", () => {
    expect(creatorLink({ label: "", url: "https://www.patreon.com/someone" })?.label).toBe("patreon.com");
  });

  it("bounds the list and drops duplicates", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ label: `L${index}`, url: `https://example.com/${index}` }));
    expect(creatorLinks([...many, ...many])).toHaveLength(6);
    expect(creatorLinks("not an array")).toEqual([]);
  });

  it("carries the rel a user-supplied link needs", () => {
    for (const token of ["nofollow", "noopener", "noreferrer", "ugc"]) {
      expect(creatorLinkRel).toContain(token);
    }
  });
});
