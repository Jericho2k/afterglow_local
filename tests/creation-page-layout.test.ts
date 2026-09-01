import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationsFor } from "./helpers/css";

const css = readFileSync(new URL("../src/app/characters/[id]/profile.module.css", import.meta.url), "utf8");
/*
 * `declarationsFor` merges every block for a selector in source order, which is
 * what a browser does — so reading the whole file back gives the PHONE value
 * for anything the phone breakpoint overrides. These two slices ask the two
 * questions separately: what the page says before that breakpoint, and what the
 * breakpoint itself says.
 */
const phoneBreakpoint = css.indexOf("@media (max-width: 700px)");
const wide = css.slice(0, phoneBreakpoint);
const page = readFileSync(new URL("../src/app/characters/[id]/profile.tsx", import.meta.url), "utf8");

/**
 * The creation page on a phone: what escapes the screen, and what appears twice.
 *
 * The overflow half of this file was found by measurement rather than by
 * reading — scripts/viewport-overflow-audit.mjs renders these exact rules in a
 * real browser at 375, 390, 393 and 430 and walks the tree for the first
 * element wider than its own box. These assertions are the structural
 * properties that measurement depends on, so that a future edit that breaks
 * them fails here rather than on somebody's phone.
 */

describe("cast cards stay inside the section that holds them", () => {
  it("gives the list a track with no min-content floor", () => {
    /*
     * `display:grid` with no declared columns is one implicit `auto` track, and
     * an `auto` track is sized to the MAX-CONTENT of its items. One member with
     * an unbreakable name, a long Cyrillic role or a run of emoji therefore set
     * the width of the list, the list set the width of the card, and the card
     * ran off the right of the page.
     */
    expect(declarationsFor(css, ".castList")["grid-template-columns"]).toMatch(/minmax\(0,\s*1fr\)/);
  });

  it("lets each card and its contents shrink", () => {
    for (const selector of [".castCard", ".castLink", ".castCopy"]) {
      expect(declarationsFor(css, selector)["min-width"], selector).toBe("0");
      expect(declarationsFor(css, selector)["max-width"], selector).toBe("100%");
    }
  });

  it("keeps the section itself inside its column", () => {
    const card = declarationsFor(css, ".card");
    expect(card["min-width"]).toBe("0");
    expect(card["max-width"]).toBe("100%");
  });

  it("never lets an uploaded image be wider than its card", () => {
    expect(declarationsFor(css, ".card img")["max-width"]).toBe("100%");
    expect(declarationsFor(css, ".castCard img")["max-width"]).toBe("100%");
  });

  it("does not hide the overflow instead of removing it", () => {
    expect(css).not.toMatch(/overflow-x:\s*hidden/);
  });

  it("does not shrink the text to make it fit", () => {
    // A readable card is the point; the fix is the track, not the type.
    expect(Number.parseFloat(declarationsFor(css, ".castCard strong")["font-size"])).toBeGreaterThanOrEqual(14);
  });
});

describe("the page's two actions appear once each", () => {
  it("has no `+` beside Start or Continue", () => {
    // The extra control between the primary action and Save is gone, and so
    // are the rules that styled it. Beginning again lives in the chat's story
    // drawer, spelled out, where it is not competing for the same thumb.
    expect(page).not.toContain("newStoryLabel");
    expect(page).not.toMatch(/ghostWide|ghostLabel/);
    expect(css).not.toMatch(/\.ghostWide\s*\{|\.ghostLabel\s*\{/);
  });

  it("hides the hero row on a phone, where the fixed bar carries them", () => {
    // Both on screen at once is a page with two answers to "what do I do here".
    const phone = css.slice(phoneBreakpoint);
    expect(declarationsFor(phone, ".ctaRow").display).toBe("none");
    expect(declarationsFor(phone, ".actionBar").display).toBe("flex");
  });

  it("keeps the hero row on a wide screen, where there is no bar", () => {
    // A floating bar would be furniture on a desktop, so the row is the one
    // instance there — and it must not have been hidden globally.
    expect(declarationsFor(wide, ".ctaRow").display).toBe("flex");
    expect(declarationsFor(wide, ".actionBar").display).toBe("none");
  });
});

describe("the fixed bar is part of the page rather than floating over it", () => {
  const phone = css.slice(phoneBreakpoint);

  it("has no fade, mask or backdrop blur", () => {
    const bar = declarationsFor(phone, ".actionBar");
    expect(bar["backdrop-filter"]).toBeUndefined();
    expect(bar["-webkit-backdrop-filter"]).toBeUndefined();
    expect(bar.background).not.toContain("gradient");
    expect(bar["mask-image"]).toBeUndefined();
    // Opaque, in the page's own surface colour.
    expect(bar.background).toBe("var(--surface)");
  });

  it("uses the page's own buttons", () => {
    // `.actionBarSave` composes `.ghostButton` in the markup and only adds room
    // for a label; it does not re-declare a border, a radius or a background.
    expect(page).toContain("${styles.ghostButton} ${styles.actionBarSave}");
    const save = declarationsFor(phone, ".actionBarSave");
    expect(save.border).toBeUndefined();
    expect(save["border-radius"]).toBeUndefined();
    expect(save.background).toBeUndefined();
  });

  it("respects the home indicator and still has room without one", () => {
    const bar = declarationsFor(phone, ".actionBar");
    // The inset is ADDED to the padding rather than replacing it, so the bar
    // clears a home indicator on a device that has one and does not float on a
    // device that has not.
    expect(bar.padding).toContain("env(safe-area-inset-bottom)");
    expect(bar.padding).toMatch(/calc\(16px \+ max\(10px/);
    expect(bar.padding).toContain("env(safe-area-inset-left)");
    expect(bar.padding).toContain("env(safe-area-inset-right)");
  });

  it("reserves its own height at the bottom of the page", () => {
    // Or the last line of the last comment sits underneath it.
    expect(declarationsFor(phone, ".page")["padding-bottom"]).toContain("env(safe-area-inset-bottom)");
    expect(declarationsFor(phone, ".page")["padding-bottom"]).toContain("100px");
  });

  it("gives the two controls real space between them", () => {
    expect(declarationsFor(phone, ".actionBar").gap).toBe("12px");
    expect(declarationsFor(phone, ".actionBar .primaryCta")["min-height"]).toBe("52px");
    expect(declarationsFor(phone, ".actionBarSave")["min-width"]).toBe("88px");
  });
});
