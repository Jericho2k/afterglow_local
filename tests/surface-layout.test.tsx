import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { creationCtaDescription, creationCtaLabel, creationTitle, inlineTitle } from "@/lib/creation";

/**
 * The surfaces long content used to break, asserted against the stylesheets
 * themselves.
 *
 * These are CSS bugs, so the stylesheet is the thing to assert on. Each rule
 * below was measured in a browser first — a rose rectangle inside the search
 * pill, a hero heading painting over an open menu and swallowing its clicks,
 * an 827-pixel chat button hanging off a 1280-pixel viewport — and each one is
 * pinned here so it cannot come back by way of a tidy-up.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const feedCss = readFileSync(new URL("../src/components/feed/feed.module.css", import.meta.url), "utf8");
const menuCss = readFileSync(new URL("../src/components/nav/menu.module.css", import.meta.url), "utf8");
const creationCss = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");
const worldCss = readFileSync(new URL("../src/app/worlds/[id]/profile.module.css", import.meta.url), "utf8");
const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const shellCss = readFileSync(new URL("../src/components/shell/shell.module.css", import.meta.url), "utf8");

/** The declarations inside one rule, by its exact selector text. */
function rule(css: string, selector: string) {
  const index = css.indexOf(`${selector} {`) >= 0 ? css.indexOf(`${selector} {`) : css.indexOf(`${selector}{`);
  if (index < 0) return "";
  return css.slice(index, css.indexOf("}", index));
}

describe("the search field has one focus treatment, on the control you can see", () => {
  it("still ships a global focus ring, which is why the reset must out-rank it", () => {
    // The rectangle's actual source. Keeping this assertion means the fix below
    // is understood as "beat this rule", not "hope the bundler orders us last".
    expect(globals).toContain("button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--rose);outline-offset:2px}");
  });

  it("resets the inner input at focus-visible, so specificity decides", () => {
    // `.search input { outline: none }` is (0,1,1) — the same as the global
    // rule — so it won or lost on emitted chunk order, and it lost. Pinning the
    // reset to the pseudo-class makes it (0,2,1) and settles it by specificity.
    expect(feedCss).toContain(".search input:focus,\n.search input:focus-visible { outline: none; box-shadow: none; }");
  });

  it("keeps a visible focus state on the pill itself", () => {
    // Removed from the wrong element, not removed. The pill lights its border
    // for any focus and adds a ring for keyboard focus, and both follow its
    // radius instead of drawing a square inside it.
    expect(rule(feedCss, ".search:focus-within")).toContain("border-color");
    const keyboard = rule(feedCss, ".search:has(:focus-visible)");
    expect(keyboard).toContain("box-shadow");
    expect(keyboard).toContain("border-color");
  });

  it("hides the native WebKit search decoration it already replaced", () => {
    expect(feedCss).toContain("::-webkit-search-cancel-button");
  });
});

describe("the three-dot menu opens above the page, and is readable on artwork", () => {
  it("ranks the hero bar above the hero copy on both detail pages", () => {
    // Measured before the fix: elementFromPoint over every menu item returned
    // the hero <h1>, which is a sibling at the same z-index and later in the
    // document. It painted over the panel and took every click.
    for (const css of [creationCss, worldCss]) {
      const bar = Number(/\.heroBar \{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
      const copy = Number(/\.heroCopy \{[^}]*z-index:\s*(\d+)/.exec(css)?.[1]);
      expect(bar).toBeGreaterThan(copy);
    }
  });

  it("uses an opaque surface rather than one that depends on the artwork behind it", () => {
    const panel = rule(menuCss, ".panel");
    // A solid base colour, so a label's legibility is not a function of what
    // the creator uploaded. The blur is decoration on top of it.
    expect(panel).toMatch(/background:\s*#[0-9a-f]{6}/i);
    expect(panel).not.toMatch(/background:\s*rgba\([^)]*0\.\d+\s*\)/);
    expect(panel).toContain("backdrop-filter");
  });
});

describe("a control is not a container for a title", () => {
  it("labels the chat button with what pressing it does", () => {
    const long = "The Everlasting Chronicle of the Nine Shattered Kingdoms and Their Forgotten Heirs Volume Two";
    const creation = { name: long, title: long, creationType: "character" as const, profileType: "single" as const, cast: [] };
    expect(creationCtaLabel(creation)).toBe("Start chat");
    expect(creationCtaLabel(creation).length).toBeLessThan(16);
    // Nothing is lost: the whole title is still announced.
    expect(creationCtaDescription(creation)).toContain(long);
  });

  it("shortens a title for compact copy without touching what is stored", () => {
    const long = "A".repeat(300);
    const shortened = inlineTitle(long);
    expect(shortened).toHaveLength(32);
    expect(shortened.endsWith("…")).toBe(true);
    // The stored value is untouched — this is a view, not an edit.
    expect(long).toHaveLength(300);
    // Short titles pass through unchanged and gain no ellipsis.
    expect(inlineTitle("Seraphine")).toBe("Seraphine");
    // Emoji and other astral characters are never cut in half.
    expect(Array.from(inlineTitle(`${"🌙".repeat(40)}`)).every((glyph) => glyph === "🌙" || glyph === "…")).toBe(true);
  });

  it("still titles the page with the creation itself", () => {
    expect(creationTitle({ name: "", title: "The Final War", creationType: "scenario", profileType: "ensemble" }))
      .toBe("The Final War");
    // And falls back to product copy rather than rendering an empty heading.
    expect(creationTitle({ name: "", title: "", creationType: "character", profileType: "single" }))
      .toBe("Untitled creation");
  });
});

describe("long unbroken content cannot set the width of a page", () => {
  it("lets every long-form text block break mid-token", () => {
    // Pasted JSON, a code block and a bare URL all contain no space. Each of
    // these was measured at 800px inside a 375px viewport before the fix.
    for (const selector of [".prose", ".roleProse", ".commentBody"]) {
      expect(rule(creationCss, selector)).toContain("overflow-wrap: anywhere");
    }
    expect(rule(worldCss, ".prose")).toContain("overflow-wrap: anywhere");
    expect(rule(creationCss, ".hashtagList li")).toContain("overflow-wrap: anywhere");
  });

  it("forbids grid items from sizing themselves to their content", () => {
    // `min-width: auto` on a grid item is how one unbreakable string widened
    // every card on the page.
    for (const css of [creationCss, worldCss]) {
      expect(rule(css, ".body")).toContain("grid-template-columns: minmax(0, 1fr)");
      expect(css).toContain(".body > * { min-width: 0; }");
    }
    // Desktop's two-column body must bound both tracks, not just the first.
    expect(creationCss).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 330px)");
  });

  it("bounds the hero heading and the chat button", () => {
    const name = rule(creationCss, ".name");
    expect(name).toContain("overflow-wrap: anywhere");
    expect(name).toContain("line-clamp: 4");
    const cta = rule(creationCss, ".primaryCta");
    expect(cta).toContain("min-width: 0");
    expect(cta).toContain("max-width: 100%");
    /*
     * The 827-pixel button on a 1280-pixel viewport was fixed once by refusing
     * to let the control grow (`flex: 0 1 auto`), which is what left it looking
     * like a chip parked at the right of the hero. It is bounded now by the
     * thing that should have bounded it all along — the 620px copy column — so
     * the control may fill its column without being able to escape it.
     */
    const desktop = creationCss.slice(creationCss.indexOf("@media (min-width: 900px)"), creationCss.indexOf("@media (min-width: 1440px)"));
    expect(rule(desktop, ".heroCopy")).toContain("max-width: 620px");
    expect(rule(desktop, ".primaryCta")).toContain("flex: 1 1 auto");
    expect(rule(desktop, ".primaryCta")).toContain("min-width: 0");
  });

  it("keeps the chat header's title on one line", () => {
    expect(globals).toContain(".identity-profile strong{display:block;min-width:0;max-width:min(52vw,520px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}");
  });
});

describe("world cards render from a summary, never from lore", () => {
  it("describes a world with no description without reaching for its canon", async () => {
    // The exact crash: `/api/worlds` returns card columns, `WorldStep` typed
    // them as full worlds, and the card read `world.content.length`. Any world
    // whose short description was empty threw and unmounted the shell.
    const { WorldStep } = await import("@/components/studio/WorldStep");
    const summary = {
      id: "bbbbbbbb-0000-4000-8000-000000000001",
      name: "Babel", description: "", coverPath: "", coverUrl: "",
      visibility: "private" as const, saveCount: 0, savedByViewer: false, ownedByViewer: true,
      creationCount: 0, creator: null, updatedAt: new Date().toISOString(),
    };
    const draft = (await import("@/components/studio/draft")).draftFromCharacter(null);
    const html = renderToStaticMarkup(
      <WorldStep draft={draft} update={() => undefined} worlds={[summary]} onWorldCreated={() => undefined} onError={() => undefined} />,
    );
    expect(html).toContain("Babel");
    expect(html).toContain("Reusable setting and lore");
  });
});

/**
 * The desktop creation hero, which had one bug that looked like two.
 *
 * The copy was six independent children, each `width: 100%` capped at its own
 * maximum and pushed right with `margin-left: auto`, so each computed its own
 * left edge. The title started 620px from the right; the tagline, capped at
 * 42ch, started roughly 120px further in — the "subtitle shifted too far
 * right". The CTA row was `width: auto` around a shrink-wrapped button and
 * started further in again — the "small floating-looking button". One cause,
 * two symptoms, and one fix: make the column the column.
 */
describe("the creation hero aligns on one column", () => {
  /** The declarations of a rule inside the desktop block. */
  function desktopRule(selector: string) {
    const block = creationCss.slice(creationCss.indexOf("@media (min-width: 900px)"), creationCss.indexOf("@media (min-width: 1440px)"));
    return rule(block, selector);
  }

  it("gives the column its own width instead of giving every child one", () => {
    const copy = desktopRule(".heroCopy");
    expect(copy).toContain("max-width: 620px");
    // The offset lives on the column now, so the children do not each carry it.
    expect(copy).toContain("margin: 0 max(34px, calc((100% - 1280px) / 2 + 34px)) 0 auto");
    expect(copy).toContain("align-items: stretch");
  });

  it("stops each child computing its own left edge", () => {
    const children = desktopRule(".heroCopy > *");
    expect(children).toContain("margin-left: 0");
    expect(children).toContain("max-width: 100%");
    // The exact declaration that caused the misalignment.
    expect(children).not.toContain("margin-left: auto");
    expect(children).not.toContain("max-width: 620px");
  });

  it("keeps the tagline's measure without letting it move the tagline", () => {
    // 42ch is a reading constraint. It must not also be an alignment one, which
    // is what it became when every child was right-aligned independently.
    expect(desktopRule(".tagline")).toContain("max-width: 42ch");
    expect(desktopRule(".tagline")).not.toContain("margin-left");
  });

  it("stretches the Chat button across the column, up to the Save control", () => {
    expect(desktopRule(".ctaRow")).toContain("width: 100%");
    expect(desktopRule(".primaryCta")).toContain("flex: 1 1 auto");
    // Wide, not tall: the shared control height is untouched.
    expect(rule(creationCss, ".primaryCta")).toContain("min-height: 52px");
    expect(desktopRule(".primaryCta")).not.toContain("min-height");
    // And Save keeps its square, which is what the CTA stops short of.
    expect(rule(creationCss, ".ghostButton")).toContain("width: 52px; height: 52px");
  });

  it("leaves the mobile composition alone", () => {
    // Below 900px the column is the full width and the CTA already filled it.
    expect(rule(creationCss, ".ctaRow")).toContain("width: 100%");
    expect(rule(creationCss, ".primaryCta")).toContain("flex: 1");
    expect(rule(creationCss, ".heroCopy")).toContain("padding: 46vh 20px 26px");
  });
});


/**
 * Two defects found in a browser, pinned so a tidy-up cannot bring them back.
 *
 * Both were invisible in the source and obvious on screen, which is why they
 * are asserted against the stylesheets rather than described in a comment.
 */
describe("the shell's grid has exactly two in-flow children", () => {
  /*
   * `main.app-shell` is `display: grid; grid-template-columns: 286px 1fr;
   * height: 100dvh; overflow: hidden`. A THIRD in-flow child turns that into
   * two rows: the sidebar moves to column two, the open view is squeezed into
   * the 286px column of the new row, and the grid grows past the height that
   * `overflow: hidden` then clips — so the view cannot be scrolled at all.
   *
   * Measured: with the banner in flow the profile page reported
   * `scrolled to 0 of 2156` and its Save control was unreachable. Both shell
   * banners are therefore positioned, and neither may go back into the flow.
   */
  for (const banner of [".account-notice", ".library-error"]) {
    it(`keeps ${banner} out of the shell's grid flow`, () => {
      expect(rule(globals, banner)).toContain("position:fixed");
    });
  }

  it("still lets the view fill its column", () => {
    expect(rule(globals, ".app-shell")).toContain("grid-template-columns:286px 1fr");
    expect(rule(shellCss, ".page")).toContain("overflow-y: auto");
  });
});

describe("the editable profile header", () => {
  /*
   * The avatar row is pulled up over the banner by a negative margin. The
   * banner is `position: relative`, which puts it in a later paint step than
   * an in-flow sibling — so until this row was positioned too, the top 12px of
   * the display name was painted over by the cover at every width and with any
   * length of bio. Measured before the fix: covered at 4 of 4 sample points.
   */
  it("paints the identity above the banner it overlaps", () => {
    const identity = rule(shellCss, ".editIdentity");
    expect(identity).toContain("margin-top: -34px");
    expect(identity).toContain("position: relative");
    expect(identity).toContain("z-index: 1");
  });

  it("has one avatar, and it is the control", () => {
    // The duplicate plain avatar this replaced is gone for good.
    expect(shellCss).not.toContain(".avatarLarge");
    expect(rule(shellCss, ".editAvatar")).toContain("cursor: pointer");
  });
});
