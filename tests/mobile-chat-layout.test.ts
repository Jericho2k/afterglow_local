import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationsFor } from "./helpers/css";

const globals = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

/**
 * Three reported phone problems, each of which is a structural property of the
 * stylesheet rather than a value anybody should be matching by eye.
 */

describe("the chat title is not sliced along the bottom", () => {
  /*
   * `line-height:1` gives a box exactly one em tall. The serif stack here
   * (Iowan Old Style, Palatino) needs roughly 1.25em for its ascenders and
   * descenders together, and the name is clipped for its ellipsis — so the
   * bottoms of g, y, p and j were cut off. The fix is leading, not padding.
   */
  for (const selector of [".chat-identity h1", ".identity-profile strong"]) {
    it(`gives ${selector} room for its descenders`, () => {
      const rule = declarationsFor(globals, selector);
      expect(Number(rule["line-height"])).toBeGreaterThanOrEqual(1.2);
    });

    it(`does not fake that room with margins instead`, () => {
      const rule = declarationsFor(globals, selector);
      // The old rule compensated for missing leading with margin:3px 0 4px,
      // which moved the box without making it any taller.
      expect(rule.margin ?? "0").toBe("0");
    });
  }

  it("still clips the name horizontally for its ellipsis", () => {
    const rule = declarationsFor(globals, ".identity-profile strong");
    expect(rule.overflow).toBe("hidden");
    expect(rule["text-overflow"]).toBe("ellipsis");
    expect(rule["white-space"]).toBe("nowrap");
  });
});

describe("the chat fits the phone exactly", () => {
  /*
   * A `1fr` grid track has an automatic minimum of min-content, so a descendant
   * that cannot shrink pushes the track past the viewport; `.app-shell` then
   * clips it with overflow:hidden, and because a grid starts at its left edge
   * the left looks right while the right is cut off. `minmax(0,1fr)` is the
   * fix; `overflow-x:hidden` on the body would only have hidden it.
   */
  it("gives every shell column a zero minimum", () => {
    for (const [selector, expected] of [
      [".app-shell", /minmax\(0,\s*1fr\)/],
      [".app-shell.sidebar-collapsed", /minmax\(0,\s*1fr\)/],
    ] as const) {
      expect(declarationsFor(globals, selector)["grid-template-columns"]).toMatch(expected);
    }
    // Including the two phone breakpoints, which declare their own tracks.
    const tracks = [...globals.matchAll(/\.app-shell\{[^}]*grid-template-columns:([^;}]+)/g)].map((match) => match[1]);
    expect(tracks.length).toBeGreaterThanOrEqual(3);
    for (const track of tracks) expect(track).toContain("minmax(0,1fr)");
  });

  it("lets every direct child of the shell shrink", () => {
    expect(declarationsFor(globals, ".app-shell>*")["min-width"]).toBe("0");
  });

  it("does not paper over the overflow with a global clip", () => {
    // The shell locks the document deliberately; what must not appear is an
    // `overflow-x:hidden` whose only job is to hide a layout that is too wide.
    expect(globals).not.toMatch(/(?:^|[};])\s*body\s*\{[^}]*overflow-x:\s*hidden/);
    expect(globals).not.toMatch(/(?:^|[};])\s*html\s*\{[^}]*overflow-x:\s*hidden/);
  });

  it("sizes full-bleed panels against their container, not the layout viewport", () => {
    // `100vw` is the layout viewport, which is not the same as the track a
    // panel sits in once anything else occupies horizontal space.
    const drawer = declarationsFor(globals, ".picker-drawer");
    expect(drawer.width).not.toContain("100vw");
    expect(drawer["max-width"]).not.toContain("100vw");
  });

  it("keeps the chat panel and its scrolling regions shrinkable", () => {
    expect(declarationsFor(globals, ".chat-panel")["min-width"]).toBe("0");
    expect(declarationsFor(globals, ".chat-identity")["min-width"]).toBe("0");
  });

  it("gives the chat panel's own column a zero minimum too", () => {
    /*
     * `.chat-panel` is a grid, and a grid with no declared columns gets one
     * implicit `auto` track — sized to the MAX-CONTENT of its items. So the
     * header stretched the panel from the inside no matter how shrinkable the
     * panel itself was, and `.app-shell{overflow:hidden}` then clipped the
     * right-hand side. Measured before and after by
     * scripts/viewport-overflow-audit.mjs: 399px of content in a 375px panel.
     */
    expect(declarationsFor(globals, ".chat-panel")["grid-template-columns"]).toMatch(/minmax\(0,\s*1fr\)/);
    expect(declarationsFor(globals, ".chat-panel>*")["min-width"]).toBe("0");
  });
});

/**
 * A LONG CREATION NAME MAY NOT DECIDE HOW WIDE THE APP IS.
 *
 * The reported symptom is content-dependent, which is the tell: "some chats are
 * perfectly aligned, others are visibly stretched to the right, especially the
 * ones with long titles". The previous fix capped the title — against the
 * VIEWPORT. A viewport is not the space the title has: on a 393px screen the
 * header spends its width on padding, a menu button, an avatar, two gaps and an
 * action, leaving about 229px for text while `60vw` allows 236. A title long
 * enough to reach its cap overflowed by a handful of pixels, every time.
 */
describe("the chat title is bounded by its container, not by the screen", () => {
  for (const selector of [".identity-profile strong", ".conversation-preview", ".chat-identity h1"]) {
    it(`${selector} is not sized against the viewport`, () => {
      const rule = declarationsFor(globals, selector);
      expect(rule["max-width"] ?? "100%").not.toMatch(/vw/);
      expect(rule.width ?? "auto").not.toMatch(/vw/);
    });
  }

  it("lets every link in the chain from header to text shrink", () => {
    // A flex item's automatic minimum is min-content, so ONE link without
    // `min-width:0` re-imposes the longest word on everything above it.
    for (const selector of [".chat-header>.chat-identity", ".chat-identity>*", ".identity-profile", ".identity-profile>span", ".identity-profile strong"]) {
      expect(declarationsFor(globals, selector)["min-width"], selector).toBe("0");
    }
  });

  it("does not let the header actions shrink instead", () => {
    // The actions are the fixed furniture; the title is the elastic part. With
    // it the other way round the buttons squash before the name ellipsises.
    expect(declarationsFor(globals, ".chat-header>.header-actions").flex).toMatch(/^0 0 auto$/);
    expect(declarationsFor(globals, ".chat-menu-button").flex).toMatch(/^0 0 auto$/);
    expect(declarationsFor(globals, ".identity-profile>.avatar").flex).toMatch(/^0 0 auto$/);
  });

  it("still truncates rather than wrapping or growing", () => {
    const title = declarationsFor(globals, ".identity-profile strong");
    expect(title.overflow).toBe("hidden");
    expect(title["text-overflow"]).toBe("ellipsis");
    expect(title["white-space"]).toBe("nowrap");
    // And still with room for its descenders; see the suite above.
    expect(Number(title["line-height"])).toBeGreaterThanOrEqual(1.2);
  });
});

describe("the composer's ends are symmetric", () => {
  it("insets the text now that the padding no longer does", () => {
    const textarea = declarationsFor(globals, ".composer textarea");
    expect(textarea["min-width"]).toBe("0");
    // A one-line composer is exactly as tall as the controls beside it, so an
    // empty composer has no vertical drift between them either.
    expect(textarea["min-height"]).toBe(declarationsFor(globals, ".send-button").height);
  });
});
