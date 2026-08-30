import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Typing inside a sheet must not close the on-screen keyboard.
 *
 * The reported symptom was specific: editing an existing persona on a phone,
 * one letter, and the field lost focus. The cause was not the persona editor.
 * `Sheet` ran its mount effect with `close` in the dependency list, and `close`
 * was derived from an `onClose` prop that every caller writes as an inline
 * arrow function — a new identity on every render, so every keystroke re-ran
 * the effect. Its cleanup restores focus to whatever opened the sheet, which is
 * what took the caret out of the textarea and dismissed the keyboard.
 *
 * These tests read the source, which needs saying plainly: this suite runs in a
 * node environment with no DOM, so mounting the component and typing into it is
 * not available here, and a synthetic re-implementation of the same two shapes
 * would only test itself. What CAN be checked without a browser is the property
 * the fix consists of — that the effect's stability does not depend on a prop
 * callers recreate every render — and that is a real regression guard, because
 * the one-line change that reintroduces the bug is exactly the one it catches.
 */

const source = readFileSync(new URL("../src/components/shell/Sheet.tsx", import.meta.url), "utf8");

describe("Sheet's mount effect", () => {
  it("does not depend on the identity of the onClose prop", () => {
    // The shape that caused it: useCallback(() => onClose(), [onClose]).
    expect(source).not.toContain("useCallback(() => onClose(), [onClose])");
  });

  it("reads the newest callback through a ref instead", () => {
    expect(source).toContain("latestOnClose = useRef(onClose)");
    expect(source).toContain("latestOnClose.current = onClose");
    expect(source).toContain("useCallback(() => latestOnClose.current(), [])");
  });

  it("still restores focus and locks the page behind, which is why it must run once", () => {
    expect(source).toContain("restoreFocus.current.focus()");
    expect(source).toContain('document.body.style.overflow = "hidden"');
  });
});

describe("every sheet caller", () => {
  /*
   * The bug was invisible at the call sites — an inline arrow is the natural
   * way to write this prop and none of them were wrong. This records that, so
   * a future reader does not "fix" the callers instead of the component.
   */
  it("is free to pass a fresh onClose on every render", () => {
    const personas = readFileSync(new URL("../src/components/shell/PersonasView.tsx", import.meta.url), "utf8");
    expect(personas).toContain("onClose={() => setEditing(null)}");
  });
});
