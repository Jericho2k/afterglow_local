import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { declarationsFor } from "./helpers/css";

const component = readFileSync(new URL("../src/components/shell/SettingsSheet.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/components/shell/shell.module.css", import.meta.url), "utf8");
/** Everything before the phone breakpoint, so a base rule can be read on its own. */
const base = css.slice(0, css.indexOf("@media (max-width: 430px)"));
const mobile = css.slice(css.indexOf("@media (max-width: 430px)"));

describe("BYOK Settings accessibility and privacy", () => {
  it("uses a labelled password input and never renders a saved raw key", () => {
    expect(component).toContain('htmlFor="settings-openrouter-key"');
    expect(component).toContain('type="password"');
    expect(component).toContain('autoComplete="off"');
    expect(component).toContain('aria-describedby="settings-openrouter-key-help settings-openrouter-key-error"');
    expect(component).toContain("•••••••• {byok.suffix}");
    expect(component).not.toContain("byok.apiKey");
  });

  it("names funding controls, status, errors, and the inline removal confirmation", () => {
    expect(component).toContain('role="radiogroup" aria-label="Writer funding"');
    expect(component).toContain('role="radio"');
    expect(component).toContain('role="alert"');
    expect(component).toContain('role="group" aria-labelledby="remove-key-title"');
    expect(component).toContain("Your chats and memories will not be deleted");
    expect(component).toContain("autoFocus");
  });

  it("states the writer/background funding and OpenRouter privacy boundary", () => {
    expect(component).toContain("replies, regenerations and continuations");
    expect(component).toContain("memory, continuity, Scene State and other background processing");
    expect(component).toContain("OpenRouter logging and privacy settings");
  });
});
/**
 * WHAT THIS BLOCK LEARNED FROM PR #19.
 *
 * The assertions here used to be byte-for-byte string matches, including
 * newlines and indentation. Every one of them fails on a reformatting that
 * changes nothing about the page, which trains people to paste the new bytes in
 * without reading them — at which point the test guards nothing. They are
 * intent assertions now, over a small declaration parser.
 *
 * THE PROPERTY THEY ARE ALL ABOUT: nothing inside a sheet may be wider than the
 * sheet. On a phone that is the difference between a settings panel and a
 * settings panel with its right edge off the screen. Every rule below is one
 * place where a child could refuse to shrink.
 */
describe("BYOK Settings responsive containment", () => {
  it("bounds long content and lets action rows wrap", () => {
    expect(declarationsFor(css, ".byokPanel")["min-width"]).toBe("0");
    expect(declarationsFor(css, ".byokActions")["flex-wrap"]).toBe("wrap");
    expect(declarationsFor(css, ".byokDisclosure")["overflow-wrap"]).toBe("anywhere");
    expect(declarationsFor(base, ".fundingChoices")["grid-template-columns"]).toContain("minmax(0, 1fr)");
  });

  it("collapses funding choices and stretches actions at 430px and below", () => {
    expect(declarationsFor(mobile, ".fundingChoices")["grid-template-columns"]).toBe("1fr");
    expect(declarationsFor(mobile, ".byokActions > *").flex).toBe("1 1 140px");
  });

  /*
   * The rules ported from PR #19. Each one is a child that could not shrink.
   */
  it("lets every level of the sheet shrink", () => {
    for (const selector of [".sheet", ".sheetBody", ".sheetBody > *", ".card", ".stack", ".field", ".tabs", ".fieldHint"]) {
      const rule = declarationsFor(css, selector);
      expect(rule["min-width"], selector).toBe("0");
      expect(rule["max-width"], selector).toBe("100%");
    }
  });

  it("lets a form control shrink below its intrinsic size", () => {
    // `width: 100%` is not enough: an input carries a minimum from its `size`
    // attribute and refuses to go below roughly twenty characters.
    const rule = declarationsFor(css, ".input");
    expect(rule["min-width"]).toBe("0");
    expect(rule["max-width"]).toBe("100%");
  });

  it("wraps a footer of long button labels rather than overflowing", () => {
    expect(declarationsFor(css, ".sheetFooter")["flex-wrap"]).toBe("wrap");
    expect(declarationsFor(mobile, ".sheetFooter > *").flex).toBe("1 1 130px");
  });

  it("contains overflow with clip rather than making a scroll container", () => {
    // `overflow-x: hidden` makes the element programmatically scrollable and
    // traps `position: sticky` descendants. `clip` says what is meant.
    expect(declarationsFor(css, ".sheetBody")["overflow-x"]).toBe("clip");
  });

  it("gives the narrowest phones their space back from the chrome", () => {
    expect(declarationsFor(mobile, ".sheetBody").padding).toBe("12px");
    expect(declarationsFor(mobile, ".card").padding).toBe("14px");
  });

  /*
   * DELIBERATELY NOT PORTED FROM PR #19.
   *
   * It bounded the backdrop and the sheet with `max-width: 100vw`. `100vw` is
   * the layout viewport including the area under a classic scrollbar, so it is
   * wider than the box it is meant to bound on exactly the desktop where a
   * scrollbar exists — the same measurement mistake the mobile chat width fix
   * had to undo elsewhere. `100%` is the containing block, which is what was
   * meant, and the sheet already had it.
   */
  it("bounds the sheet against its container, not the layout viewport", () => {
    expect(declarationsFor(base, ".sheet")["max-width"]).toBe("100%");
    const backdrop = declarationsFor(css, ".sheetBackdrop");
    expect(backdrop["max-width"] ?? "").not.toContain("100vw");
    // `position: fixed; inset: 0` already sizes it to the viewport exactly.
    expect(backdrop.position).toBe("fixed");
    expect(backdrop.inset).toBe("0");
  });

  it.each([375, 390, 393, 430, 768, 1024, 1280, 1440])("has a bounded layout strategy at %ipx", (width) => {
    expect(width <= 430 ? css.includes("@media (max-width: 430px)") : css.includes("minmax(0, 1fr)")).toBe(true);
    // Capped on a wide screen, full width on a phone: both are "100% or less".
    expect(declarationsFor(css, ".sheet").width).toContain("100%");
  });
});
