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
